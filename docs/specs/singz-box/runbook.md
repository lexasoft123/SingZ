# SingZ Box runbook

## Launch

Run commands from the repository root after the normal
[development setup](../../DEVELOPMENT.md). Desktop remains the default;
Box development uses an explicit selector:

```bash
npm run dev                 # Desktop development
npm run dev:box             # Box development, windowed
npm run build               # main/preload + isolated Desktop and Box renderers
npm run start:box           # production Box, fullscreen/kiosk
```

For a windowed production run, set `SINGZ_BOX_WINDOWED=1`. `SINGZ_SURFACE=box`
is an alternative development selector. Hidden E2E runs never enter kiosk mode.
The dedicated [Box package](packaging.md) starts Box without a selector.

Production outputs are `out/renderer/index.html` for Desktop and
`out/renderer/box/box.html` for Box. Box assets stay under
`out/renderer/box/assets/`; they are not merged into Desktop's asset graph.

## Included behavior

- Prepared local projects and a shared Drive collection, with verified
  stems/lyrics download, retry, cancellation and retained offline cache.
- Readiness requires nonempty prepared stems and strict cached synchronized
  lyrics. Partial, damaged, unsupported, empty-stem and malformed projects do
  not enable Sing. Original audio is optional when those checks pass.
- Cached lyric validation preserves real timing, accepts 50 ms rounding
  tolerance and legacy zero spans, and rejects out-of-line, backward,
  non-finite, empty and untimed data. Opening a song never invokes lyric
  search, transcription or alignment.
- One app-lifetime `MultitrackEngine`: paused open, native transport clock,
  play/pause/seek, end handling, per-word highlighting and explicit cleanup.
- Audio Settings with native device inventory, remote navigation and draft
  Apply/Cancel. Linux/ALSA output selection is session-only. Browsing preserves
  playback; Apply pauses and never resumes automatically. Mac/Windows preview
  device lists are read-only. Failed rollback blocks Play and seeking; retained
  native quarantine requires an app restart.
- On-demand mixer, persistent queue and accepted per-project mix snapshots.
  Reorder/remove never changes the active song. Switching asks for confirmation
  and opens paused; there is no automatic queue consumption.
- Remote spatial navigation, amber focus, five-second singing chrome timeout,
  and complete wake-chord consumption, including repeats and releases.
- Setup, account, approved/revocable phone controls, storage, diagnostics,
  capability-gated network/system pages and privacy controls.
- English, Russian and Simplified Chinese dictionaries. Other locales use
  English in memory without changing Desktop's saved language preference.
- Chrome-free production fullscreen/kiosk. Desktop keeps its normal window,
  updater, preferences and launch behavior.

Unknown artist and unavailable analysis display `—`; neither artist nor
microphone activity is inferred. Local splitting, lyric authoring and editing
remain in Desktop SingZ. Microphone monitoring uses the external mixer. Real
Wi-Fi provisioning and signed automatic system updates/rollback require an
appliance OS service; those actions are disabled when it is unavailable.

## Native policy and shutdown

Desktop native/storage preferences are unchanged. Linux Box uses an in-memory
native+streaming policy and requires a capable native backend. It does not
silently present a Web Audio fallback as native. A detached browser AudioContext
avoids claiming the default output before native inventory and route selection.
The same policy drives lane measurement, prepare-ahead and Play/rebuild.

Normal close has a Box-only handshake: pause, flush accepted controls and project
saves, complete bounded native cleanup, then acknowledge close. Renderer cleanup
is bounded at eight seconds and main has a twelve-second fallback. Application
quit resumes only after every requested window completes. Hard-kill/crash
persistence is not promised.

## Application checks

```bash
npm run typecheck
npm test
npm run build
node tests/e2e/box-smoke.cjs
node tests/e2e/box-cjm-smoke.cjs
```

Run app drivers sequentially. They use isolated userData/library/models/pack
roots, generated silent fixtures and no production account. After desktop-only
bootstrap, generate the mobile shared modules required by the full suite as
specified in [development checks](../../DEVELOPMENT.md).

To run the basic smoke against an installed app, set `E2E_PACKAGED` to its
executable before `node tests/e2e/box-smoke.cjs`. Packaging and co-installation
checks are documented in [packaging](packaging.md).

## Device acceptance

Use a supported board/TV/audio interface and a separate test profile/library.
Retain the prior runtime and a rollback path before replacing an appliance
runtime. App checks do not authorize firmware, hardware mixer or host OS changes.

Verify fresh startup focus without pointer input, actual directions/OK/Back,
4K scale and fonts, output inventory, explicit route Apply and paused song open.
During playback, inspect native frame/callback progression, underrun/error
counters and the physical PCM format. Browse mixer/queue/settings, then verify
Back and wake-only input. Pair a handset, approve it on TV, exercise playback,
mixing and queue changes, and revoke it. Confirm QR scanning and audible output
with a person; telemetry alone cannot establish either.

Qualify microphone routing/monitoring, USB reconnect/device-loss recovery,
long-run playback, latency and physical CEC/HID behavior separately. Network
provisioning, signed image installation, boot health and rollback need real
OS-service and failure-injection tests; the screen contract alone is insufficient.

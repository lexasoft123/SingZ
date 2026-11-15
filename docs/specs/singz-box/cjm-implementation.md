# Box journeys implementation

The Box application integrates setup, collection preparation, playback, queue,
phone controls, storage, diagnostics and maintenance screens with shared SingZ
services. Network provisioning and system updates require an appliance OS service;
unsupported operations remain unavailable rather than reporting simulated success.
See [the product specification](spec.md) for the complete customer journey and
[the runbook](runbook.md) for reproducible checks.

## Application boundaries

- `src/shared/box-contract.ts` defines the typed service contract. Renderer
  adapters consume its result objects instead of duplicating an API.
- `src/main/box/` owns Box persistence, verified collection preparation, approved
  phone sessions and the platform adapter. Project, Drive and audio behavior
  remains shared with Desktop.
- `JourneyHub` composes setup and settings pages under
  `src/renderer/src/box/journeys/`. The parent owns remote input, spatial focus,
  routing, audio and transport. The hub exposes `back()`, `open(page)` and
  synchronous `isInteractionLocked()` for navigation and transport guards.
- Box uses the production UIKit night tokens and Desktop font assets, with
  scoped styles in a 1600×900 logical surface uniformly scaled to a 4K TV frame.
  Long content scrolls inside that frame.

## State and safety contracts

Asynchronous reads are scoped to their current owner. Replacement requests,
unmounts and canceled operations invalidate older results. Current project,
playback and backend capabilities are rechecked when a command is issued.
Preference hydration cannot overwrite a newer safe-area or locale choice.

Confirmations default to Keep or Cancel. Cache removal protects the active
project, including while paused, and removes only verified downloaded cache;
it does not delete ordinary local projects or their cloud sources. Queue order
uses stable project identity and survives cache replacement.

Drive authorization and guest phone pairing are independent. Pairing uses a real
HTTP listener, expiring invitations, explicit TV approval and revocable sessions.
Phone snapshots expose opaque song/stem identifiers and human labels, not local
filesystem paths. Playback and mixing wait for authoritative engine acceptance.

System mutations require a fresh platform snapshot and capability/playback
preflight. Once installation or rollback commits, further mutation and outward
navigation remain locked until a later snapshot reports completion. QR codes
encode backend-provided validated URLs; the renderer does not synthesize
connection, approval, update or recovery outcomes.

## Implementation coverage

“Implemented” describes the application contract; it does not qualify a missing
OS service or a physical hardware route.

| Screens / acceptance | Application behavior | Remaining qualification |
| --- | --- | --- |
| S01–S05 / A01–A06 | Boot readiness, welcome, EN/RU/zh-CN language, remote check, persisted safe area, offline continuation, reusable network/audio/account routes, persisted setup completion; no autoplay | Hardware readiness, remote compatibility and microphone setup |
| S06–S09, S20 / A07–A11 | Shared Drive account status/authorization, catalog and verified stems/lyrics preparation; cancellation/retry and offline cache; unavailable songs cannot open as ready | Real provider/network failures and supported appliance deployment configuration |
| S10–S15 / A12–A18 | Paused song open, native transport/lyrics, on-demand mixer, persistent queue, accepted saved mix, browsing continuity and complete wake-chord consumption | Audible output, sustained latency/reliability and supported physical remotes |
| S16 / A16 | Phone start/state/approve/deny/revoke/stop, backend URL/code/expiry, controller playback/mix/queue commands; no owner account access | Physical handset QR scanning and LAN reachability |
| S18–S19 / A04 | Real interface/link snapshots, fresh Wi-Fi capability checks, unavailable/offline/Ethernet states and retry; Internet is never inferred from a link | Wi-Fi provisioning, phone credential handoff and recovery network require the OS service |
| S21 / A11, A18 | Real cache/storage/free-space state; Keep-first confirmation; active-cache protection; completed eviction refreshes the library | Storage and interrupted-download failure injection on supported devices |
| S22 / A19 | Scoped diagnostics and audio/setup recovery; opt-in persistent Linux Box read-only reattach to the same host epoch/generation restores the actual project, synchronized lyrics and current native controls, with explicit Refresh/Stop fallback; approved audio/routing summary fields only, no raw object/log/secret serialization | Retained-recovery E2E qualification, device-loss recovery and hardware qualification |
| S23–S25 / A20–A21 | Platform versions/capabilities, update/reboot/rollback commands, command-time guards and committed-operation locks; unavailable firmware version is labeled Application version | Signed images, staging, boot health and A/B rollback require the OS service |
| S26 / A22 | Real Drive sign-out, phone-session revocation and scoped cache removal; safe confirmation; capability-gated factory reset | Factory reset remains unavailable without a qualified OS service |
| Navigation / NAV-01/04/05 | Parent-only input, stable focus markers, confirmation isolation, Back/return context and valid focus restoration | Physical CEC/HID behavior and couch readability |
| Localization / A03 | Shared locale lookup, EN/RU/zh-CN dictionaries, key/placeholder parity; Box preferences remain separate | Long translations and Russian/CJK viewing-distance checks |

## Verification

Unit and service tests cover navigation, stale-result suppression, initial
preferences/focus, native-startup policy, accepted controls, cache safety,
Unix-socket mutation locks, authorization and localization. The existing
Electron drivers exercise actual app and mobile-browser behavior:

- `tests/e2e/box-smoke.cjs`: prepared stems-only playback, lyrics, native frame
  continuity, mixer/queue, remote wake, 4K scaling and close/restart persistence.
- `tests/e2e/box-cjm-smoke.cjs`: setup, mock-provider Drive approval and verified
  download, phone approval/control/revocation, offline playback after sign-out
  and restart, and safe cache removal.
- `tests/e2e/box-audio-host-smoke.cjs`: independent headless native host/socket
  controls, reconnect identity and shutdown. Alone it does not cover renderer
  close/restore.
- `tests/e2e/box-retained-recovery.cjs`: generated 180-second stems-only fixture,
  synchronized lyrics and a non-null project graph; private HOME/XDG/profile
  roots, muted logical routes and a device-free environment; actual
  `BrowserWindow.close` and Box relaunch while the independent host stays alive.
  Qualification requires a commandable running or paused transport, real UI
  project/lyrics/current controls/position, and the same host epoch and
  generation through close and read-only reattach after relaunch. Refresh while
  retained is safe and preserves that identity; explicit Stop is the controlled
  fallback and must confirm release of the reviewed identity. A test-only
  private Unix-socket recorder observes actual native RPCs and must reject
  forbidden automatic RPCs while permitting that explicit release. Final
  end-to-end qualification remains required.

The mock provider supplies deterministic network outcomes; it is not evidence
of a live provider authorization. Physical USB/HDMI stream telemetry verifies
routing and native frame progression, but cannot establish speaker audibility.
Short playback checks do not establish professional latency or long-run stability.
Microphone monitoring currently uses the external mixer. The retained-recovery
driver does not qualify FLOW 8 routing, physical microphones, CEC or audible
latency. Native-service crash/restart and power-cycle persistence are not
guaranteed.

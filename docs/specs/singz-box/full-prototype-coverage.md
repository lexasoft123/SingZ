# Full browsable prototype coverage

This document describes the connected design prototype, not production service
or hardware support. The prototype uses SingZ UIKit and the default Desktop font
assets. Current production scope is tracked in [the implementation map](cjm-implementation.md).

The TV always uses a 3840×2160 canvas. Preview size scales it uniformly. Display
safe area scales the entire inner TV surface while preserving that outer frame;
phone pages are separate responsive surfaces. Directions, OK and Back control the
TV. The outside-TV screen navigator and simulated outcome selectors help review;
normal product buttons connect setup, catalog, singing, settings and recovery.

## Screen inventory

| Spec screens | Product entry | Browsable states and return path |
| --- | --- | --- |
| S01 Boot/readiness | Initial launch; Settings → Remote & display | Starting/checking, ready, service failure/retry; continue setup or browse local songs. Startup/failure selection is a review fixture. |
| S02 Welcome/language | Setup → Welcome | English design with a disclosed language preference preview; continue or set up later. Full localization is not implemented. |
| S03 Remote/display | Setup → Remote & display | Direction/OK recognition, safe-area 0/3/5%, restore; all content respects selected inset until reset. |
| S04 Setup network | Setup → Network | Existing link or offline; opens the same Network screen; Back restores setup step. |
| S05 Setup audio | Setup → Sound & microphones | Output readiness, routing and bounded microphone check; opens the same Audio screen, returns to setup. |
| S06 Drive authorization; P02 | Setup → Collection; Settings → Google Drive; preparation → Connect Drive | QR/code, separate mock phone approval, denied/expired/canceled/renewed/offline; approval changes the shared owner snapshot. No credentials are requested. |
| S07 Catalog | Finish setup; Collection | Artist-first flat rows, musical metadata, optional icons; loading/empty/offline/stale/error fixtures; Connect collection and Current song actions. |
| S08 Song details | Catalog song | Ready, download, repair, lyrics missing, unsupported/unknown fixtures; original metadata, transpose, queue. Back restores catalog row. |
| S09 Preparation | Song → Prepare/Repair; lyrics retry | Download → verification → ready; cancellation, account required, offline, no-space, integrity and unsupported outcomes. Shared availability commits only after verification. Storage cleanup supports retry. |
| S10–S12 Player/singing/wake | Song → Sing; Queue/Phone → select prepared song | Paused entry, play/seek/end, large swept lyrics, 5-second hide, full first wake sequence consumed; no autoplay (Next is explicit; at end focus Next with Replay). |
| S13–S14 Mixer | Player → Mix | Main and all six stems, independent mics, absolute levels/mute/solo, unavailable inputs; playback continues, Back lyrics. |
| S15 Queue | Catalog/Player → Queue; phone Queue | Reorder, remove, manual selection, empty/unavailable rows; shared verified availability; queue pick opens paused without consuming; player Next starts the next song and removes the one that played. |
| S16 Phone pairing; P03 | Settings → Phone controllers | Independent QR/code, approval/denial/expiry/revoke; local phone Playing/Queue/Songs/Mix surfaces. Same transport, queue and nine mixer channels; revoked/disconnected phones cannot command. No owner settings. |
| S17 Audio | Settings → Audio; setup Audio | Draft/effective output and mic sources, validation, Apply/Cancel, paused apply, failure/unplug/retry, bounded checks. Back player or calling setup step. |
| S18–S19 Network; P01 | Settings → Network; setup Network; offline recovery | Effective link separate from pending candidate; QR/phone-only password, expiry/cancel/retry, offline AP bootstrap, bad password/missing network/timeout/no-internet. Back player or calling setup/preparation context. |
| S20 Account | Settings → Google Drive | Signed-out/signed-in/expired, approval and safe sign-out; local projects and independent phone pairing survive. |
| S21 Storage/offline recovery | Settings → Storage; failed preparation → Manage storage; offline network recovery | Local project list, protected current song, confirmation defaults Keep, local-only removal, no-space/corruption/check fixtures; offline songs and retry routes. |
| S22 Audio/UI recovery | Missing output → Settings → Audio; Settings → Diagnostics | Audio retry/settings, UI reconnect/diagnostics, service failure/restart; no output fallback or automatic playback. |
| S23 System | Settings → System & updates | Current/known-good version, automatic-check preference, checking/current/no-update/ready/staged/deferred; network and signature/target failures. |
| S24 Update | System → Download/Install | Confirm defaults Cancel; command-time playback guard, verification, committed install/restart/health; Back and review navigation locked during committed stages. |
| S25 Rollback | Update simulated failed health check | Automatic restore of known-good version, explicit Continue; restart preserves projects/account/settings and leaves playback stopped. |
| S26 Privacy/ownership | Settings → Privacy | Independent sign-out, revoke phones, clear local songs, factory reset; safe Cancel, idle guards. Factory resets preferences and downloads without changing installed firmware identities or cloud files. |
| S27 Lyrics recovery | Sample Radio project → Prepare lyrics; lyric fixture | Missing/empty/untimed/out-of-sync; retry preserves stems; no invented timings or implicit instrumental mode. |

## Shared state and safety evidence

Project verification is root-owned and feeds Catalog, Song, Queue and Player.
Prepared cloud songs become selectable in every view. Cache removal immediately
blocks playback without falsely reporting an output-device error. Active project
removal is protected; bulk deletion requires stopped playback. Normal restart
preserves data/preferences; factory reset clears them while retaining actual mock
installed/known-good version identities. Drive approval and guest pairing have
independent expiring sessions. Preparation and handoffs reject cancellation,
expiry and stale completions. Phone input controls mutate the same mock player.

## Runtime boundary

The QR images are genuinely encoded and independently decoded from screenshots.
Their reserved `.invalid` destinations are deliberately not hosted: use the
separate phone preview buttons to exercise the local workflow. No Wi-Fi AP,
Google OAuth request, project file, audio stream or OS image is created. Network,
file verification, meters, account approval, signing and rollback are simulated.
All state is session-local and reload resets the demonstration. English-only
localization and real CEC/HID/TV readability remain unqualified.

A01/A02/A04–A07/A10–A12/A16/A18–A24 installed-app, native-service, persistence,
security and hardware acceptance requires separate implementation and tests.
The prototype establishes connected UX and failure behavior, not those runtime
contracts. The prototype acceptance boundary remains distinct from the production test drivers.

## Prototype interaction checks

- Connected browser journey: 75 checks, including setup return contexts, independent QR decoding, verified preparation, paused entry, wake-only controls, shared phone transport and rollback.
- Failure/reset journey: 30 checks, including denial/expiry, canceled task negative control, no-space cleanup/retry, shared stem readback, revocation, active-session install block, signature refusal, no-update and factory scope.
- Regression browser suites: Player 66, Queue 56, Mixer 81, Audio 64 and Network 41. Setup/account/controller isolated suite: 22.
- Actual sandboxed inline renderer: 14 checks using keyboard activation for TV and preview-launch controls; phone actions, shared stem mutation, decoded pairing QR, Wi-Fi verification, narrow phone layout and remote scrolling passed. Full mouse journeys are covered in the standalone browser test host; inline review controls are also keyboard-accessible.
- Model suites: Player 27, Queue 15, Mixer 19, Audio 26, Network 23, account/pairing 16, update/privacy 31, project-readiness guard 6 and reset-version identity 6. No renderer errors in passing suites.

Hidden TV previews retain their last nonzero scale, preventing a zero-size
intermediate canvas when returning from a phone page. TV focus restoration skips
phone and review controls during background transport updates. Phone pages appear
before review controls, and scrolling settings reserve room for the focus outline.
These checks establish the mock interaction contract; they do not qualify native
provisioning, sound, persistence, actual Google authorization or system updates.

# SingZ Box prototype audit

This is a historical design-gap audit of the initial prototype, not a statement
of current production coverage or approval of that prototype's appearance.
The [design plan](redesign-plan.md) replaces its composition with the Desktop
SingZ visual language. [Full prototype coverage](full-prototype-coverage.md)
records the connected design reference; [the implementation map](cjm-implementation.md)
records production behavior.

## Audit boundary

The initial browser prototype demonstrated prepared-song playback, hidden
controls, mixer and several settings states using simulated services. Browser
interaction, screenshot and focus checks could characterize those states but
could not establish native audio, persistence, live authorization or hardware
support. The subsequent geometry correction established one 3840×2160 UHD frame
with uniform preview scaling; changing the frame did not implement missing
journeys.

## Findings retained as design requirements

| Gap | Required behavior | Specification |
| --- | --- | --- |
| First use began directly in the catalog | Boot readiness, language, remote/display check, network/audio setup and optional account, including usable offline continuation | J02–J06; A01–A07 |
| Phone codes lacked a destination and failure flow | Independent Drive approval and guest-controller pairing, phone-side pages, denial/expiry/cancel/retry/revocation; no account access inferred from pairing | J04/J06/J12; A04/A07/A16 |
| Reload discarded prepared/queue/mix state | Persist supported application state; design offline, storage-full, integrity, missing-device and service-recovery outcomes | J08/J14/J16; A11/A18/A19 |
| Queue entry paused playback and lost the return context | Keep current transport independent of queue order, preserve playback while browsing, return to current lyrics and confirm song switches | J11; A15; PLAY-03 |
| Useful metadata stopped at the catalog | Carry key/tempo/range into details; retain unknown/stale states and distinguish original from playback key | J07; A08/A09 |
| Text size and screen size were inconsistent | Fixed UHD geometry, shared type roles and uniform scale; qualify viewing-distance comfort on a real TV | J07/J09/J10; A03 |
| Settings declared success without validation | Separate draft/effective state, revalidate capabilities, preserve prior route on failure, expose applying/disconnected/retry and bounded deliberate tests | J04/J05; A04–A06 |
| Updates only covered timer-driven success | Check/no-update/staged/deferred/signature/install/boot-health/failure/known-good recovery; no simulation presented as actual system success | J15; A20/A21 |
| Lyrics recovery and owner handoff were missing | Explicit missing/empty/untimed lyrics; safe sign-out/cache/phone-revocation/reset scope; no fabricated lyric timing | J09a/J17; A22/A23 |

## Acceptance interpretation

A browser “UI verified” result covers an exercised simulated interaction only.
A partial screen still needs its complete state contract. A missing service or
hardware capability cannot be supplied by a visual fixture.

The accepted product direction is an artist-first compact catalog and
lyrics-first player. Full acceptance also requires first-run and phone handoffs,
preparation/recovery, shared-service round trips, persistence and physical
remote/audio tests. The product specification's A01–A24 cases remain the release
reference; historical prototype checks do not waive them.

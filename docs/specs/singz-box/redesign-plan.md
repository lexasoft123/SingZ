# SingZ Box design plan

## Goal and boundaries

SingZ Box is a separate TV application that visibly belongs to SingZ Desktop,
follows [the product specification](spec.md), and works with directions, OK and
Back. Reuse real UIKit and shared application/domain behavior. Desktop retains
its own UI; Box does not require a framework migration or a parallel DSP-only
implementation of project logic.

The design baseline is Desktop's compact chrome, default fonts, night palette
and control anatomy. Earlier prototype compositions are historical references,
not source templates. Do not carry forward accumulated override CSS, fabricated
lyric timing or simulated service success.

## Desktop anatomy to retain

| Reference | Box adaptation |
| --- | --- |
| SingZ title strip and navigation | Wordmark and quiet Box qualifier on the left, grouped application navigation, contextual song identity, separate utility/status controls on the right; no OS window controls |
| Default Bricolage Grotesque and Martian Mono fonts | Import the same assets and assign UIKit display/mono tokens; musical/numeric metadata uses the mono face |
| UIKit Button, SegmentedControl, Chip, StatusDot and Modal | Keep the actual fills, borders, pill geometry, primary amber highlight and dialog actions; scope only TV sizing/spacing |
| Desktop library hierarchy | Collection heading and quiet local/Drive status above one internally scrolling artist-first list; storage management belongs in Settings |
| Desktop lyric rendering | Ivory read-ahead, per-word amber sweep and restrained fixed current-word glow; no guessed timing or pulsing line glow |

Use the dependency pinned by `package-lock.json`; do not upgrade UIKit to solve
a layout problem. Shared palette tokens express the night background, surface,
ivory text and amber focus. Strong hero gradients, decorative waveform artwork
and pervasive bloom are outside this visual direction.

## Frame and alignment

Every TV route and overlay uses one 3840×2160 UHD (16:9) frame. Layout uses a
1600×900 logical surface uniformly enlarged to the display. Smaller previews
scale the whole surface, without responsive TV breakpoints or content-sized
screenshots. Phone pages are separate responsive surfaces.

Keep a compact title strip, consistent 40-unit page gutters, aligned heading
baselines and shared button heights. The catalog, settings and recovery screens
share text roles. Singing retains the large lyric role. Scrolling content stays
inside its viewport with enough room for a full focus outline.

## Screen composition and interaction

| Screens | Composition and behavior | Specification |
| --- | --- | --- |
| S07 Catalog | Flat rows: Artist, Song, Key, Tempo, Vocal range, Time and optional named state icon. No artwork, availability text column or per-row Play target. Headers align with cells; time is right-aligned. Opening a row inspects/prepares rather than starting audio. Unknown metadata is `—`. | BOX-03–05/08/11; A03/A08/A09 |
| S08 Details / S09 Preparation | Artist and song shown once, catalog metadata retained, original key separate from playback key; no decorative waveform. Sing is enabled only when ready. Preparation distinguishes transfer from verification and offers Cancel/Retry and truthful failure states. Back restores the catalog row. | A10/A11; PREP-01–03 |
| S10–S12 Player / singing / wake | Large contextual lyric lines dominate; compact header and slim bottom transport. Open paused; show the Up next line. Hide controls after five idle seconds only while singing. First keydown, all repeats and matching keyup only reveal controls; restore Play focus. Held input, pause, end, overlays and recovery do not hide. | A12/A13/A17; NAV-05–09 |
| S13–S14 Mixer | On-demand Main/Stems sheet using UIKit controls, labeled absolute levels, mute/solo and stem colors. Playback continues. Back closes only the sheet and restores Play. Missing/unavailable inputs are explained, never given synthetic activity. | A14; AUDIO-01–03 |
| S15 Queue | Flat list with explicit select/move/remove actions. Queue order and current playback are separate. Browsing preserves transport; Back returns to current lyrics. Choosing a song from the queue confirms the switch, opens it paused and consumes nothing. Sing on song details and the player Next action ask the same question whenever another song is loaded and has not ended (paused or playing); with nothing loaded, or once the song has ended, they start without asking. The player Next action is the exception: it starts the next queued song (after the switch confirmation while a song is loaded and not ended, directly once it has ended or with nothing loaded) and removes the song that just played from the queue once the next one opens. Nothing advances by itself: no autoplay at song end; focus moves to "`Next: <song>`" with Replay beside it, or Replay alone with a disabled Next when the queue is empty (Next is always present in the bar). | A15; PLAY-03 |
| S17 Audio | Draft and effective routes remain distinct. Directions/OK operate controls without native menus or typing. Apply/Cancel are reachable. Apply pauses; rejected changes retain the prior effective route and never auto-resume. | A05/A06 |
| S18–S19 Network | Actual link state, pending/error/retry/offline, working-route preservation. QR, URL and code support phone-only credential entry. Unavailable OS capabilities remain explicitly unavailable. | A04 |
| S06/S20 Account / S16 Pairing | Distinct owner Drive authorization and guest phone control. Pending/denied/expired/cancel/retry states; offline songs survive sign-out. No invented approval or connection result. | A07/A16 |
| S21/S22/S27 Recovery | Retain song context; offer meaningful Retry/Back/offline alternatives. Missing lyrics never become fabricated sync; instrumental continuation needs an explicit product decision. | A18/A19/A23 |
| S23–S26 Maintenance / ownership | Same settings structure, signed-image and committed-operation states, idle install, failure/recovery and least-destructive initial focus. Explain local versus cloud scope. | A20–A22 |
| S01–S05 Setup / P01–P03 Phone | Reuse network/audio/account destinations, remote/display check and offline continuation. Phone controls remain independent from owner credentials. | A01–A07/A16 |

## Remote contracts

Exactly one enabled actionable target owns focus. Up/Down traverses catalog or
queue rows without wrapping and scrolls the target into view. Remember stable
row identity and scroll independently of DOM index. Header navigation and list
navigation form explicit groups; Back restores a valid target.

While mixing, Up/Down selects a channel, Left/Right adjusts its focused level,
and OK moves among level/mute/solo actions. Main/Stems and close remain reachable.
Tab is contained. Closing an overlay consumes the held Back chord so it cannot
also leave the player. Auto-hide resumes with a full deadline after closing and
releasing input.

Master/lead/stem/microphone controls refer to explicit channel identities.
Absolute levels and mute/solo state survive closing the overlay. Mute wins over
solo; multiple solos are allowed. Missing/disconnected channels retain settings
but are disabled and excluded from solo participation. Hardware preamp and mixer
commands require a separately qualified adapter and authoritative readback.

## Verification gates

- Exact UHD and uniformly scaled previews; no page overflow, clipped focus or
  content-dependent frame sizes. Long collection/settings content scrolls inside
  the fixed surface.
- Loaded real fonts, consistent headings/gutters, compact title strip, grouped
  navigation, quiet status and recognizable UIKit controls. Palette parity alone
  does not establish the same design language.
- Remote entry/exit, boundaries, held keys, offscreen targets, stable selection,
  disabled actions and safe confirmation defaults.
- Long artist/title, unknown analysis, local-ready, Drive-only, offline and corrupt
  project cases. Sample data is disclosed outside the TV frame.
- Player generation/frame and mix continuity across mixer, queue, catalog and
  settings. Test first-wake suppression with a deliberate fallthrough negative
  control, and overlay visibility with an invisible-but-clickable negative control.
- Stale/canceled/expired outcomes cannot promote a network, account, preparation
  or system operation to success.

Prototype interaction checks, production service checks and physical acceptance
are separate gates. Screenshots cannot establish couch readability, audible
routing, microphone monitoring, actual authorization, network provisioning or
signed system recovery. The complete prototype's scope is recorded in
[full-prototype coverage](full-prototype-coverage.md); production coverage is in
[the implementation map](cjm-implementation.md).

## Shared-service integration

Box owns TV composition, focus/navigation and appliance adapters. Shared project,
library, Drive, preparation, editing and audio services remain the source of
business rules, with stable IDs, explicit results and authoritative snapshots.
Use adapters before extracting or moving unrelated Desktop code. Shared-service
contract tests and Desktop/Box project round trips enforce A24.

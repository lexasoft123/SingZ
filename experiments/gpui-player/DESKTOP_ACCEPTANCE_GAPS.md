# Full desktop acceptance gaps

This is a current-source functional audit, not a completion percentage. The full
desktop goal remains active. Passing a renderer fixture or a unit suite does not
qualify every route, physical device, platform or production image.

## Concrete integration work

| Gap | Current evidence | Required implementation and acceptance |
| --- | --- | --- |
| Saved empty project → Drive sync — local checkpoint passed | Dedicated publication/recovery and automatic continuation pass 943 Rust tests and the real two-size writer → fresh reader → offline journey (six launches, 14 captures). Pending no longer claims “up to date”. | Local fixture integration is qualified; real Google and Windows/Linux qualification remain open. See `EMPTY_DRIVE_REVIEW.md`. Delete/Rename/name reuse is the separate lifecycle gap below. |
| Publication history after Delete/Rename and name reuse — local checkpoint passed | Exact local-operation authority, immutable ordinary upload recovery and catalog-last retirement pass 1,009 Rust tests. The actual two-size Delete-last → same-name reuse → typed Rename → same-name reuse journey passes two launches and 20 captures. | Local lifecycle integration is qualified; real Google and Windows/Linux qualification remain open. Preserve recovery archives, replacement admission and the unavailable-library guard. See `RETIREMENT_DRIVE_REVIEW.md`. |
| Windows audio-provider qualification | Native Settings, preferences and helper now carry explicit provider intent and availability, refuse unavailable providers without fallback, and fence changes against active or retiring audio owners. Independent microphone/monitor inventory stays on WASAPI. | The repaired provider source at `14715b4e` passes Dell build/tests and the hidden native provider/restart journey (`provider5`, `provider-ui3`). Keep broader platform workflows, full codecs and physical audibility separate. ASIO remains unavailable until a licensed adapter and driver are implemented and qualified. See `WINDOWS_PROVIDER_REVIEW.md`; source and macOS checks do not close this platform gate. |
| Windows full-codec delivery — SDK layout fix | Dell compiled and installed the pinned public FFmpeg source after English MSVC resource installation. A relocated Python-process probe passes DLL versions/licenses/configuration and 20 decoder/five demuxer lookups. The inspector now accepts upstream `bin/component.lib`; nine assembly tests pass. | Fresh SDK publication with the repaired builder, full canonical decoding matrix and relocated codec-enabled helpers/app remain open. The older published public source snapshot was audited and transferred to VM403; current public app711ac271/UIKit6f694bf also reached both targets. VM403 full-codec helpers/check pass, but its first Rust suite is rejected; mode transport and probe-fixture repairs precede target app/UI qualification. See `WINDOWS_CODEC_REVIEW.md`. |

Training's previously missing result reveal, acknowledgement and task-specific
Summary copy now have a scoped EN/RU two-size native checkpoint; see
`TRAINING_FEEDBACK_REVIEW.md`. Native scoring, receipt identity, cue timing and
capture ownership remain intact. This does not establish complete visual parity.

Settings playback graph integration now has a native ordinary/custom graph
checkpoint, with generation replacement, keyboard module/connection reading and
Save/reopen. Shared UIKit displays actual compiled topology; malformed/stale
metadata is validated independently. See `PLAYBACK_GRAPH_REVIEW.md` for exact
binary and runtime evidence. Full production visual and invalid-metadata renderer
qualification remain open.

Native desktop Drive browse/download/offline-open now has a separate reader and
verified cache, including stem-only and saved-graph native playback. Its final
hidden online/offline journey passes 29 captures with actual search/cancel/retry
and exact payload checks. See `DRIVE_RESTORE_REVIEW.md`. This supplies the reader
dependency for empty-project sync; the strict empty reader fixture does not
qualify publication by the native writer. The publication checkpoint above now verifies the production writer as well;
real account/platform qualification remains open. The separate retirement lifecycle now has the local checkpoint in `RETIREMENT_DRIVE_REVIEW.md`.

## Qualification gates

- The runtime-graph checkpoint passed 887 Rust tests. Successive Drive reader
  suites passed at 901, 903 and 906 tests. A later suite recorded 908 passed,
  one engine-probe failure and two explicit installed-model ignores. The
  Library focus-repair source passes 909 tests with zero failures and those same
  two ignores. The provider-boundary repair's macOS retry passes 922 tests;
  its preceding run passes 921 with one occurrence of that same engine-probe
  failure. The repaired Windows provider source passes 865 tests, zero failures and two
  ignores, plus the actual hidden provider/restart journey on the Dell. This
  closes that scoped boundary gate; broader Windows delivery remains open. The empty-publication checkpoint now passes 943 tests, zero failures and two
  ignores. The later retirement/name-reuse snapshot passes 1,009 tests with zero
  failures and those two ignores. The historical intermittent
  two-second engine-probe shell fixture
  remains unresolved; neither an isolated pass nor this full pass closes it. The source
  probe budget is 45 seconds; Qwen health readiness uses a separate 180-second
  budget. No deadline or assertion was relaxed.
- Production visual and temporal parity still needs the complete matching
  fixture/state matrix. Exact native regression images establish regression
  scope only. Preserve the approved native partial-glyph/glow standard.
  The compact ruler's partially covered final tick now has a scoped native fix
  with same-frame measured clearance and 24 inspected captures; see
  `RULER_CLEARANCE_REVIEW.md`. Measured lyric overflow and single-owner wheel
  input now have 20 native cases and 363 pixel-exact pre/post lyric-panel pairs;
  see `LYRICS_SCROLL_REVIEW.md`. Its follow-up corrects the scrollbar-corner
  classification: the canonical reference included the corner. Long-clock/
  localized ruler coverage and production image comparisons remain open.
  Drive platform observers are prepared but have not run on the targets;
  see `PLATFORM_DRIVE_QUALIFICATION.md` for the resolved public-snapshot transfer audit and outstanding target execution.
- Shared UIKit controls now have a scoped own-process native macOS AX checkpoint,
  including range actions, disabled refusal and modal isolation; the configured
  Drive tour now has actual offscreen reveal coverage. See
  `NATIVE_CONTROLS_GUIDE_REVIEW.md`. Whole-app accessibility, native selector
  expanded-state bridging, all-locale layout and actual live announcements remain open.
  A presentation diagnostic named `announce` is not platform accessibility proof.
- Physical microphones, permissions, device hotplug, audible monitoring/output,
  OS chooser presentation, remaining Windows/Linux scenarios and packaged live
  Drive consent are not established by generated replay or loopback services.
- Hidden macOS captures do not establish live display cadence. CPU/footprint and
  system GPU observations must stay separate from unavailable live FPS.
- Ad-hoc package verification is not signing/notarization or release readiness.

The worktree's `SCREEN_PORT_STATUS.md` and focused review documents retain the
implemented routes, exact fixtures and historical evidence. Resolve these
concrete gaps before treating broad historical “remaining work” notes as closed.

## Immediate completion order — 2026-11-09

1. The verified empty-publication checkpoint is committed and pushed as `3ce6fa7e`.
2. Exact-ID retirement and same-name reuse now pass the local suite and actual
   two-size UI journey. Preserve immutable upload recovery before retirement.
   See `RETIREMENT_DRIVE_REVIEW.md` for exact scope and outstanding platform gates.
3. Finish remaining Windows/Linux codec/configured delivery and the qualification
   gates above. Repeat previously passing matrices when a change affects them or
   a failure requires it.

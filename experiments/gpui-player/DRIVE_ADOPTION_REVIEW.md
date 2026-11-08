# Native Drive adoption and offline playback — 2026-11-08

The missing combined local workflow is now exercised through actual hidden native
controls. The fixture publishes a phone project over loopback OAuth/HTTP, pauses
the source-audio response at 64 KB and 256 KB, and releases each gate only after
the mounted app reports the corresponding progress and captures both sizes.
The two-line source status fits at 1280×800 and 1060×640. No destination song
exists while these partial transfers are held.

The final workflow also clicks Cancel during the first held transfer, verifies
that no partial payload or published song remains, then clicks Sync now. The
verified 62,473-byte project metadata survives in private staging; server request
records prove that resume does not download it again. The source audio is fetched
again, verified and atomically published before the remote adopted tag.

The new catalog row appears through the normal library refresh. The test clicks
its measured card, checks the two native DSP lanes and saved gains, song volume,
24 timed lyric lines, credit and generated glyph masks, and starts playback through
the actual transport. Native position advances. A real bass M click reaches native
telemetry; Cmd/Ctrl-S persists it without losing foreign metadata or audio/lyrics
bytes. After stopping the fixture server and closing its socket, a second app
process opens the catalog card and plays the saved arrangement offline, including
the mute and lyrics. No new authorization URL or accepted fixture request appears.
This qualifies muted native playback/IPC, not physical speakers or audible quality.

The final hidden batch passes 56 captures across five app processes: adoption,
cancel/resume and offline reopen (22), existing writer/Save/restart regression
(22), and actual library deletion/conflict/ownership regression (12). Every driver
passes its existing integrity/control assertions. Foreground identity is unchanged.
App CPU/footprint and system GPU samples are archived; helper CPU is excluded from
the new adoption observer. Live display FPS remains unmeasured.

Verification found and fixed a separate accepted-socket bug. On Darwin a socket
accepted from a nonblocking listener inherits O_NONBLOCK. The adoption HTTP fixture
set socket timeouts but did not clear that flag, so `read_line` could immediately
fail with WouldBlock. A private-loopback reproduction measured flags=6 and a 0ms
failure; explicitly blocking the same accepted socket made its 100ms read timeout
take about 101ms. The fixture now explicitly selects blocking mode. Other native
HTTP fixtures already did this.

The real OAuth callback had the same inherited mode and could busy-spin on an
incomplete browser header. It now selects blocking mode before its existing 50ms
read and 500ms write timeouts. The two-second callback deadline and generation/
cancellation checks are unchanged. A fragmented-header regression keeps a real
TCP connection open, cancels after 120ms and refuses an excessive poll count;
tokens remain absent. The initial full suite failure (751 passed, one adoption
fixture WouldBlock failure, two ignored) is retained. After this fix the complete
suite passes 753 tests, zero failures and two ignored. The earlier independent
engine-probe startup timeouts remain unresolved; this does not claim to fix them.

Normal and UI-feature builds, Python compilation and eight comparator self-checks
pass. All 86 shared/dist font hashes are unchanged. UIKit controls and the approved
continuous glyph fill/core/glow/halo were not edited. The horizontal lyrics scrollbar
and white corner are deliberate earlier source-parity work documented in REVIEW.md;
they were inspected and preserved, rather than removed as an assumed defect.

The initial successful 18-image native adoption batch remains immutable. Strict
full-image comparison against it gives 3/18 exact and 15 different; four new
cancel/resume states lack an earlier image. Private fixture paths, equalizer and
waveform entrance timing, transfer-rate text and live lyric/playback timestamps
were not frozen, so these are regression image comparisons without a complete
parity contract. Full originals, overlays and differences remain unmasked. They
are not current production Electron references.

Evidence and source recovery are archived in `gpui-drive-adoption-20261108` under
this chat's visualization directory. Native-empty reader compatibility, malformed
ledger recovery, retained-root scope policy, escaped UTF-16 graph compatibility,
all-locale/accessibility, real Google consent/assets, physical devices, Windows/
Linux, packaging and production visual/temporal qualification remain open. The full
desktop objective remains active.

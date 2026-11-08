# Native Log dialog — screen and durable backend

## Locale follow-up — 2026-11-08

The native and fixture viewer chrome now uses the existing `library.logPanel.*`
source keys for title, session placeholder, counts/tail status, Copy feedback,
Save, loading/empty text and saved path. Close uses `library.common.close`.
Shared UIKit adds label-accepting title/empty/saved helpers while keeping the
English wrapper APIs. Diagnostic rows and copied/exported content remain raw;
the source explicitly keeps engine log lines in English. Session date formatting
and accessibility still need locale qualification.

Final UI and normal builds pass. The final Rust suite passes 747 tests, 0 failed,
2 ignored. The expanded hidden/muted locale workflow passes 59 captures at both
sizes, now including real English/Russian Log Copy and byte-for-byte comparison
with the displayed rows; the driver restores the prior clipboard. Existing
durable diagnostics checks pass 32 captures with sessions, long/Unicode rows,
selection/scroll/focus, stale receipts and exports. Static screen captures pass
18/18 strict historical native comparisons. Dedicated Log fixtures pass 6/6
strict historical native comparisons, text selection and dismissal. Comparator
self-checks pass 8 tests. Foreground identity remains unchanged in the locale
and diagnostics drivers. Live display FPS remains unmeasured.

The earlier intermittent engine-status two-second fake-command timeout was
investigated without modifying engine behavior, deadlines or tests. Six complete
747-test runs with read-only observation of test-owned child processes passed;
the failure did not reproduce, so its root cause remains unresolved. The final
post-localization 747-test run also passed; these results do not establish a fix.

Evidence, source overlays and immutable comparisons are archived in
`gpui-log-locale-20261108` in this chat's visualization directory. This establishes
native functionality and historical native image stability, not production pixel
parity, full locale/layout/accessibility coverage or Windows/Linux qualification.
The full desktop goal remains active.

The header Log route opens a native modal over catalog/player. Layout comes from production
`LogPanel.tsx` and `.log-*` CSS: 860px card, 22px/24px padding, 240px minimum body, 11px mono
rows at 1.7 line height, shared modal material/buttons/selectors/scrollbar. Text selection
uses GPUI Kit's existing selectable text/window layer. No bespoke common controls added.

Normal native data now comes from real worker diagnostics and durable per-launch
sessions. Copy uses the actual shown rows with local-time timestamps and resets
its acknowledgement after two seconds. Save exports the current live ring or the
full selected past session through an independent native worker. Explicit fixture
events remain confined to isolated tests; the original visual fixtures are immutable.

## Durable backend checkpoint

`diagnostics.rs` keeps the source's 4,000-entry live ring, millisecond timestamps,
levels and 2,000-UTF-16-unit line limit. The config `logs` directory retains this
launch plus ten previous sessions. ISO UTC lines follow the source
`SingZ <version> — <platform>-<arch>` header. Info batches flush at 500 ms;
warning/error and shutdown flush promptly. At 8 MiB, the source cap warning is
written once and subsequent entries remain live-only. The bounded disk queue
reports pressure drops; the live ring retains the latest rows independently.
Real project lifecycle, engine command/provider decisions and streamed bounded
stderr feed this sink without filesystem work on the UI thread.

Past sessions preserve raw/unparseable and partial lines. The panel displays only
the last 4,000 rows and their full total; Copy uses those shown rows, while Save
preserves the entire selected past file. Request IDs, modal sessions and selection
generations fence stale receipts. Dismissal cancels reads/listing; an accepted
export can finish without reopening the panel or changing a newer instance.
Exports use staged publication at the chosen path, refuse symlinks/unapproved
overwrite and protect changed destinations. Session reads are ordinary-file and
size bounded; rotation preserves foreign, linked and oversized files.

`/tmp/singz-diagnostics-unit-final.log` records 359 Rust tests passing, zero failures
and two explicitly ignored real-engine cases. Coverage includes persistence,
restart/rotation, source formatting/tail behavior, cap/flush, queue pressure,
cancellation and export safety. Actual subprocess tests cover inherited pipes
after direct-child exit and complete delayed output. Unix process-group cleanup
is tested; Windows descendant cleanup is not qualified. Save-path interception
does not verify actual native save-dialog presentation or overwrite confirmation.

Final hidden/muted UI v6 passes in
`/tmp/singz-diagnostics-ui-v6-driver.log`. Its 32 candidate PNGs in
`/tmp/singz-diagnostics-ui-v6` span seed/review/short launches at 1280×800 and
1060×640. The checks cover the long Cyrillic/emoji UTF-16 split row, intrinsic body
sizing, shrinking from a 4,000-row past session to short current content, clearing
session-popup inventory on reopen, Copy acknowledgement reset and clipboard
restoration, follow-scroll, full past Save and stale Save receipt fences.
Model-manager and source-workflow regressions pass in
`/tmp/singz-diagnostics-models-regression-driver.log` and
`/tmp/singz-diagnostics-source-regression-driver.log`.

Engine-setup and sidebar regressions also pass. The normal build passes in
`/tmp/singz-diagnostics-normal-build.log`. All 84 strict native full frames match
the engine-setup baseline; all six historical native Log fixtures remain identical.
Evidence is finalized in the [completed diagnostics review](/Users/maxplanck/.codex/visualizations/2026/11/05/01a1add5-9a90-73c3-bec3-c18bfb04e619/gpui-diagnostics-20261107/REVIEW.md). These workflow results do not supersede the immutable production comparison failures
below or certify temporal parity, live FPS, actual native chooser presentation
or Windows descendant cleanup.

## Initial screen verification and immutable evidence

- Normal and `ui-tests` builds pass; full hidden regression smoke passes.
- Dedicated Log checks pass at 1280×800 and 1060×640, scale 2: empty/12-row captures,
  actual row text selection, visible past-session option click, Close, popup-first Escape
  and outside-scrim dismissal. Clipboard is untouched by automated tests.
- Source reference is the rebuilt Electron app in an isolated profile, hidden/muted,
  sync disabled, forced sRGB. IPC serves declared fixtures; unrelated live log events are
  suppressed. No UI is fabricated in HTML. Foreground application is unchanged.
- Durable evidence (source/candidate PNGs, sidecars, hashes and strict diffs):
  `/Users/maxplanck/.codex/visualizations/2026/11/05/01a1add5-9a90-73c3-bec3-c18bfb04e619/gpui-log-port/`.
- Reference `/tmp/singz-log-port-reference-2`; candidate `/tmp/singz-log-port-native-6`.
  `native/review-manifest.json` identifies tested binary and source hashes independently
  of subsequent normal-build output. Popup screenshots additionally show the deferred menu.

## Visual verdict: changes still required

All four strict full-screen comparisons differ; **zero cases certified pixel-perfect**.
At 1280, mean absolute channel errors are 0.154164 (empty) and 0.919196 (rows); at 1060,
0.193647 and 1.349352. Full screenshots, overlay and difference images were inspected.
Existing background/grain/blur raster differences contribute to full-window mismatches;
row source-column advance and text/baseline differences remain visible in the overlay.
The counter color was corrected from DIM to the source FAINT token. Do not hide remaining
pixels by aligning, masking or changing comparator thresholds.

Persisted history, live updates and file export are now implemented as described
above. Final hidden native workflow checks cover long Cyrillic/emoji rows,
large-history follow-scroll, current/past content resizing and clipboard timing.
Matched production evidence for those states, long/unbroken text across locales,
session-menu visual parity and temporal/accessibility qualification remain open.
Live FPS remains unmeasured. Backend and workflow completion do not certify
pixel-perfect visual parity or complete the desktop port inventory.

# Effective BPM and count-in — verified native integration checkpoint

Source authority is production `Transport.tsx` BpmEntry/CountInDots, App's
handleTempo/analysisNote, engine.nativeCountInStatus/nativeCountInOffsets and
DesktopNativePlaybackClient.countInHeard. Common native visuals remain in sibling
UIKit. No Node is used. This is an implementation review, not a parity certificate.

The effective BPM entry shows rounded base BPM × requested tempo. Its numeric
entry selects on first focus, filters non-digits and commits positive targets on
Enter or blur; Escape discards. Steps change effective BPM by one. Source tempo
requests clamp to 0.5–1.5 and round to four decimals. Accepted project tempo stays
separate from responsive requested UI state: one native request runs at a time,
with the latest subsequent request retained. Only proved native receipts update
saved state. Monitoring releases its input/output lease before dispatching one
coalesced typed rate intent. Ordinary transport/mixer commands remain FIFO-queued
behind native rate preparation. Playback intent uses an exact command serial
receipt, never a matching boolean or receipt wall clock, so delayed earlier
Play/Pause responses cannot acknowledge a later toggle. Superseding a deferred
Open cancels its entire queued navigation segment; owned source completion
preserves queued rate Save/navigation across its internal reopen. Save/Open waits for the whole request chain and then uses the existing
publication lifecycle. Requested edits mark the header dirty, queued Save shows Saving, and blocked
rename/import controls are disabled. Native refusal retains verified audio; uncertain/fatal
failure retains the document paused with reopen feedback. Generic failure reports
cancelled queued Save and retains navigation until acknowledgement.

Analysis overrides an existing BPM with the source percentage bar. Real native
melody stderr progress is drained with bounded line storage, filtered and fenced
by actual analysis job identity and project epoch. Joined cancellation emits Stop;
same-epoch restarts receive new IDs and reset progress. Beat progress follows the
existing accepted detector job. A separate frozen 42% UI case is a candidate visual,
not evidence of inference. The actual native melody CLI emits periodic progress
and terminal melody JSON; it does not emit a fabricated final 100% message.

Count-in uses the native render clock minus rate-scaled presentation latency,
retaining the heard tail after landing. Source preceding-beat offsets, pickup,
local variable meter and gridless three-tick bars determine completed dots. A
200 ms bounded projection preserves source between-poll behavior. Offsets retain
the accepted beat-grid allocation and are prepared once per graph/landing/rate/
metronome state; frame painting performs no beat-grid scan or allocation. Dots are
accent ●/○ grouped by bar, 12 px with 2 px tracking. Song position stays at the
paused anchor during audible pre-roll. Pause, seek and navigation retire the row.

Final evidence (2026-11-08):

- 576 Rust tests pass, zero failures and two ignored; final UI-feature and normal
  builds pass. Eight strict-comparator self-checks pass. All 86 bundled font files
  remain byte-identical to the previous checkpoint.
- Actual native count-in and Carry signal suites pass. Real native melody analysis
  succeeds with five progress messages and 1195 melody frames; executable/source
  hashes are retained. The analysis UI capture is explicitly a frozen candidate,
  separate from real inference and worker/job-adoption tests.
- Final hidden timing UI v15 passes 57 captures across 1280 × 800 and 1060 × 640
  logical pixels, 2× scale, exercise and independent restart. It covers real
  keyboard selection/filter/Enter/Escape/blur, effective BPM clamps and steps,
  moving playback, accepted rate receipts, grid/gridless/variable-meter heard
  count-in dots, paused anchors/cancel/stale fences, same-BPM replacement,
  queued rapid edits/Save/Open, actual helper failure with unchanged saved data,
  explicit Save cancellation and acknowledged navigation.
- Actual held native rate receipts exercise Pause button, Space, three/four rapid
  toggles ending paused/playing and the real mixer M control. Native receipt
  serials preserve the latest playback intent; observed lane controls prove M
  reaches the existing helper and is restored. Ordinary UI state alone is not
  used as the native mixer oracle.
- Final monitor UI v15 passes input stop → Off → unpark → accepted typed rate,
  actual BPM click, coalesced tempo/transpose, queued Save/navigation and saved
  restart. Its 59-row ownership trace contains three native-pending observations;
  all occur after monitor ownership release. Saved tempo 1.1/transpose −1 reopen
  paused. Deferred Open retains later commands; superseding Open cancels its
  entire command segment. These are fake-device checks, not real mic qualification.
- Existing four-process Carry and three-process empty-project UI regressions pass
  on the same final UI binary. Focused independent host review has zero findings.
- Strict historical native comparison: 35/84 full frames are exact (18 screens,
  17 training). The 49 lyric full frames differ only in physical bounds
  [1626,1514,1886,1566], where enabled BPM/steps replace the disabled placeholder.
  All 49 approved lyric-region frame hashes, positions, fonts and glow-draw counts
  remain exact. Full reference/candidate/overlay/difference images were inspected;
  baselines and thresholds were not changed. No production visual-parity claim.
- Timing performance: 73 main-app CPU samples, median 23.58%, peak 89.54% of one
  core during offscreen capture; audio helpers excluded, GPU system-wide only.
  Both timing process foreground observations remain unchanged. Live FPS and
  audible hardware behavior remain unmeasured.

Durable evidence and source recovery:
`/Users/maxplanck/.codex/visualizations/2026/11/05/01a1add5-9a90-73c3-bec3-c18bfb04e619/gpui-transport-timing-20261108`.
The archive includes final/rejected runs, source/font/binary identities, native
receipts, CPU/GPU samples, strict comparisons and source recovery copies. No
commit/staging or user preview replacement was performed.

Defect loop:

| Case | Expected / observed | Cause and current state |
| --- | --- | --- |
| v3 numeric typing | `a1b5c0` → `150`; input stayed `120` | Capture listener prevented GPUI's text handler. Printable events now propagate. |
| v4 first focus | First `a` replaces all text then sanitizes empty; actual `120a` → `120` | Native mouse caret handling defeated select-all. First-focus selection now follows mouse handling and preserves later caret/drag selection. v5 passed this case. |
| v5/v6 outside blur | Draft `96` commits rate 0.8; input lost focus while rate stayed 1.25 | Inactive windows suppress focus-path notifications; cached child rendering skipped edge reconciliation. Direct focus handling plus deferred pointer/Tab and host reconciliation are implemented; v8 and v10 passed this case. |
| v8 Save shortcut | Ctrl+S queues Save after Enter; actual keyboard blur left no app focus | Keyboard-only BpmClosed now restores the local player focus immediately. Outside blur preserves the newly focused target. v10 passed native queued Save/Open. |
| v11 restart viewport | Exact requested 1060 × 640; captured 1280 × 800 | Wait for measured native viewport settlement before a separate capture. No image rescale or assertion relaxation. |
| rate/monitor interaction | Rate controls must stop monitoring through confirmed ownership release | Typed deferred/coalesced rate and durable command queue pass actual native monitor UI v15. |
| rate/fast controls | Pause, seek and mixer remain responsive during preparation | Backend FIFO plus command-serial Playback acknowledgement pass held-receipt button/Space/mixer/rapid-toggle checks at both sizes. |
| analysis restart | New job starts at 0%; old percentage/terminal result must not survive | Actual job IDs, Started/Stopped and joined cancellation are covered by worker tests. |
| native error behind rate/Save/Open | Explicit Save cancellation; navigation waits for acknowledgement | Generic error preserves the destination and reports Save failure. Actual helper-error UI case passed in v10. |

The former disabled BPM footer is intentionally different from the historical
native full-window baseline. This is a source-backed functional change, not an
accepted production rasterization exception. Production-matched visual and temporal
captures remain required. Approved lyric highlighting keeps its existing authority.

Account/Drive sync, remaining desktop controls and the full production visual,
temporal, locale, accessibility, hardware and Windows/Linux matrices remain open.

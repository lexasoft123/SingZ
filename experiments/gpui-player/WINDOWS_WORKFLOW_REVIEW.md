# Dell Windows native workflow checkpoint — 2026-11-08

Four additional native UI workflows pass on app SHA-256
`2aa8180235a1eaf09455977926ffd0b80a7ef54b4f08e905dbc3582e9b12221a`.
This extends the filesystem checkpoint; it does not establish production visual
parity, physical-device support or full desktop completion.

| Workflow | Evidence | Captures |
| --- | --- | ---: |
| Header rename | Runtime13: Unicode title/folder rename, Enter/blur, Escape/blank refusal, collision/external-edit protection, paused and playing mix/position, library/search focus, unsaved source Save | 6 |
| Library Copy/Move | Runtime13: actual native workers, held-stage audio continuity, captured root, stale status/navigation fences, Save handoff, collisions, external edits, focus trap and six-second nonblocking toast | 11 |
| Project deletion | Runtime14: four actual deletions, unchanged sentinels, exact four-directory dirty ledger, unrelated playback, writer refusal, loaded failure paused recovery, stop/clear and no resurrection | 12 |
| Training recording/export | Runtime14: actual native capture helper with PCM replay, CREPE receipts, six retained takes, four byte-identical native 16 kHz WAV exports, keyboard controls, collision protection, navigation retention and stale take clearing | 12 |

All four passing cases use hidden, muted app-local input and unchanged foreground
identity. The Windows runner verifies exactly one app process for each new driver,
equal client/outer bounds and all eight frameless resize hit codes. The successful
41 PNGs cover both 1280×800 and 1060×640 logical viewports at 2× scale. Native
file-dialog path choice is intercepted by the UI-test adapter; actual validation
and export workers run. Physical microphone capture and real OS dialog presentation
remain unqualified.

Test-tooling changes remove Mac-only header click coordinates using the measured
header Songs anchor. Fixture roots canonicalize before native identity comparison;
existing parent identity uses samefile, deleted-path checks normalize only the
Windows verbatim namespace/case, and inventory keys use POSIX relative separators.
Windows Python runs in explicit UTF-8 mode for Unicode fixtures. The Windows wrapper
now supports these four drivers and records native helper hashes. No production
appearance, shared UIKit, font or native DSP source changed in this checkpoint.
Mac `cargo check --features ui-tests` passes. The preceding filesystem checkpoint's
718 Windows / 770 Mac tests are retained as preceding suite evidence; they were
not rerun after these test-adapter-only changes.

Runtime13 as a combined host did not pass: after title and import passed, deletion
was interrupted by a separate foreground PowerShell process. Its PID/start time
were distinct from the owned GPU sampler. Narrow PowerShell startup-event analysis
identified an external `sample.ps1` outside the verification checkout/lab, launched
with `-WindowStyle Hidden`, at 06:34, 06:44 and 06:54 UTC. That external task was
not changed or terminated. Runtime14 retries deletion/recording in a quiet interval
with the same strict focus guard and passes as one clean host. Failed runtime13
deletion artifacts remain preserved. Earlier focus incidents are not attributed
to this launcher without their own event evidence.

CPU/RSS samples are separated into app and helper roles. Per-app GPU engine sums
are archived, including one unavailable import sample. These are active scripted
workflows with renderer readbacks, not idle benchmarks. Live display FPS remains
unmeasured; stepped captures do not establish display smoothness.

Visual inspection of `editing-1060.png` confirms the existing narrow-header title
editor clips at the right edge (approximately x=522 logical), and Open is truncated
to “Ope…”. These remain open defects, not accepted exceptions. The inspected
`take-ready-1060.png` has separated guidance and bottom controls; no production
reference pair was captured for this checkpoint. Broad visual/temporal parity
remains unqualified. Approved partial-glyph lyric paint remains unchanged.

Native helpers remain at:

- Audio: `36fc045d9404d9ddd9463f547b9cc6dd619b53092da762aecb34d8b8ba46ab76`
- Input: `97b66e2d01205a9a296a60e201ff909256fcac39a13c23092186e9ce9d18ae67`
- Analyzer: `a38929cd766bb816e8b6ba7fd5ed625c7a7b6f46dd0284687dca70149a97e9bd`

The archive is `gpui-windows-workflows-20261108` in this chat's visualization
folder: per-case `verified-workflows.json`, `resource-summary.json`, raw Dell
runtime13/14 results, frames/state metadata, WAVs, build logs, eight-file source
overlay and a fresh source/process retirement receipt. All eight current local and
Dell source hashes match; all owned app/helper/GPU processes are retired and all
owned scheduled tasks are terminal. Reconstruct from the preceding filesystem
checkpoint's original Windows source bundle, its 25-file overlay, then this
checkpoint's eight-file overlay. The downloaded workflow ZIP SHA-256 is
`2b8d32362ac4a2486cb8a43929c36ca1a322cd125344f269f71157c52c9886bb`.

Remaining work includes narrow-header fixes, current production reference captures,
remaining Windows workflows, hardware/models/live services, all-locale/accessibility,
Linux native integration and packaging. The intermittent Mac engine-probe timeout
is still unresolved. No Node/Electron was run, user library/account changed, global
input sent, or user preview replaced. The full desktop goal remains active.

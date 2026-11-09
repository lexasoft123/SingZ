# Native Drive integration — local checkpoint

The native app now implements the current checkout's desktop Drive writer and
published-phone adoption path. Account and sync controls use the shared UIKit;
OAuth, HTTP, planning, file snapshots and scheduling run independently of playback.
There is no Node or Electron in this implementation or its verification path.

This is not a production-readiness or visual-parity claim. The desktop Drive
browser from a different historical checkout is not present in the current
production source and is not implied by these controls.

## Implemented contracts

- Loopback OAuth with state and S256 PKCE; private credentials, persistent account
  generations, bounded locks and refresh fencing. A rejected refresh reports
  “sign in again”; explicit cancellation or sign-out suppresses stale errors.
- Source-backed Connect, Sync, Cancel, Log and Sign out controls, per-project
  status, keyboard navigation and account/receipt restoration after restart.
- A durable dirty ledger and source scheduler, with writer marks for Save,
  lyrics, import, rename, split, deletion and storage changes. Ordinary atomic
  ledger publication is a typed transient read conflict, not worker termination.
- Coherent leased snapshots and verified private upload spools. Native Save runs
  separately from playback control and can complete during an HTTP upload;
  the in-flight bytes stay immutable and the newer save earns a follow-up sync.
- Managed-file reconciliation, metadata-last publication, catalog-last commit,
  conservative deletion guards, published-folder exclusion and pagination.
  Missing project metadata does not authorize deleting its remote folder.
- Published-phone adoption with integrity verification, private resumable staging,
  atomic local publication, and a durable marker before marking the remote folder
  adopted. Portable graph validation preserves opaque future formats and raw bytes.

The picker refreshes its rows after sync without restarting the account worker.
Only an actual root change or completion of a storage move resumes its root fence.
Busy ownership lasts through ledger cleanup, receipt persistence and terminal
scheduler publication. Tests must wait for a new completed receipt, rather than
accepting an older clean snapshot after clicking Sync.

## Verification and remaining work

Local Rust and Python fixtures exercise actual loopback OAuth, HTTP uploads and
downloads, durable filesystem publication, cancellation and recovery. Native UI
checks use hidden, muted windows at 1280×800 and 1060×640, app-local input and
`Window::render_to_image`; they never activate a window or send global input.
Final local verification (2026-11-08):

- 723 Rust tests passed, 0 failed, 2 ignored; normal and UI-feature builds passed.
- Hidden Drive UI v6 passed both sizes across two actual app processes: 22 PNGs,
  two local OAuth callbacks, immutable upload-spool proof, live native Save during
  held upload, automatic follow-up publication, cancellation, picker keyboard
  controls, truthful blocked badges, restored account/receipt and final token
  tombstone. Foreign project/audio/lyrics bytes remain exact. Both foreground
  observations stayed unchanged. Earlier failures remain in the evidence archive.
- Timing (57 PNGs/two processes), monitoring, Carry (20 PNGs/four processes),
  empty projects (16 PNGs/three processes) and picker/storage (12 PNGs/four
  processes) regressions passed after the Save/Drive changes.
- All 84 full native screen/training/lyric frames are strictly pixel-identical
  to the immutable transport-timing checkpoint, including all 49 lyric frames
  and their paint metadata. The official comparator and its eight self-checks
  passed, with no masks, transforms or relaxed thresholds. This is native
  regression evidence, not a production Electron comparison.
- All 86 bundled UIKit/dist font files retain their prior hashes. The Drive icon
  is the source asset, shared by the UIKit controls.
- Drive exercise CPU: 34 app samples, median 27.03%, peak 99.87% of one core.
  Restart: six startup/capture samples, median 80.58%, peak 100.66%. Helper metrics
  are separate, GPU readings are system-wide, fixture CPU is excluded, and live
  FPS is unmeasured. These capture workloads are not a live-playback benchmark.

Durable evidence, rejected runs, comparator outputs, source recovery and identities:
[/gpui-drive-20261108](/Users/maxplanck/.codex/visualizations/2026/11/05/01a1add5-9a90-73c3-bec3-c18bfb04e619/gpui-drive-20261108/REVIEW.md).
Private generated OAuth configuration and live credentials are excluded.
No staging, commit or preview-app replacement was performed.

Still open:

- Live Google consent, account visibility under `drive.file`, real remote assets,
  browser presentation, Windows/Linux and packaged-app qualification.
- Matched production screenshots and animation sequences, locale/accessibility,
  and live display FPS. Hidden stepped captures do not prove live smoothness.
- Explicit native-empty publication now has a dedicated recovery transaction and
  a verified writer/fresh-reader/offline journey; generic snapshots retain the
  missing-audio refusal. See [empty publication](EMPTY_DRIVE_REVIEW.md). Authorized
  folder retirement/name reuse and real account/platform qualification remain open.
  Missing graphs remain blocked without a false synced receipt.
- Adoption now receives streaming HTTP byte counts and source-style download
  totals/speed before transfer completion; four held-response/authenticated tests
  preserve cancellation and integrity-gated publication. See the
  [progress follow-up](DRIVE_PROGRESS_REVIEW.md) for scope and recurring full-suite
  probe failures. The [combined adoption workflow](DRIVE_ADOPTION_REVIEW.md) now
  verifies actual streaming screenshots, cancel/resume, native playback/mixer/Save
  and server-stopped offline reopen. Real Google and hardware/platform/visual
  qualification remain open.
- Escaped UTF-16 stable names and object keys now retain source-compatible identity
  in the validation-only graph projection, with exact raw HTTP publication and
  invalid-endpoint refusal verified. See the [portable graph string checkpoint](DRIVE_GRAPH_REVIEW.md).
  Saved native graph opening/playback is now connected with separate materializer
  limits; see the [native graph checkpoint](NATIVE_GRAPH_REVIEW.md). Broader parser,
  topology and platform qualification remain open.
- The source dirty-ledger limit still collapses more than 100 distinct project
  scopes into a whole-library mark; retained roots across that limit need a policy.
- Malformed/unsafe private-ledger failures remain blocked without resetting intent.
  After external repair, Sync now recovers in the same worker, with receipt
  re-verification and newer/outside-library intent preserved. See the
  [local-state recovery checkpoint](DRIVE_RECOVERY_REVIEW.md), including the
  remaining full-suite engine timeout and verification limits.

The full desktop-port objective remains active. Approved partial-glyph lyrics,
advancing glow and the brighter leading/final glyph remain the native visual standard.

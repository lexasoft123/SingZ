# Native project deletion checkpoint — 2026-11-07

Status: **native deletion checkpoint verified on macOS**. Final hidden runtime v6
passes at both sizes; 422 Rust tests pass (2 ignored). All 84 existing native
screen/training/lyrics frames remain identical. This does not establish full
production parity, Windows/Linux qualification or a completed desktop port.

Evidence is retained in
[gpui-project-delete-20261107/REVIEW.md](/Users/maxplanck/.codex/visualizations/2026/11/05/01a1add5-9a90-73c3-bec3-c18bfb04e619/gpui-project-delete-20261107/REVIEW.md).

## Implementation and source semantics

Production references are `src/main/projects.ts::deleteProject`,
`src/renderer/src/components/DropScreen.tsx::confirmDelete` and
`src/renderer/src/App.tsx::handleDeleted`. Native implementation files are
`project_delete.rs`, `project_delete_host.rs`, `project_delete_dialog.rs`,
`integration.rs`, the catalog in `library.rs` and shared UIKit confirmation
controls. The accepted target is its authoritative project directory, never
its displayed title; same-name projects remain distinct.

Inspection reads the saved project off the UI/audio threads and returns name,
stem count, lyrics presence, byte size and captured metadata/tree identities.
The confirmation initially focuses Keep. Accepted deletion disables both actions
and blocks Escape/scrim dismissal until the operation settles.

The domain validates current-library containment and ordinary paths, refuses the
root/external/linked targets, and revalidates the captured confirmation. It
acquires config/library, library-root and project writer leases, then checks the
current root inside that config lease. The project is hidden under private
`.singz-native-delete-` staging before durable deleted-sync intent is marked.
Failure or cancellation before commit rolls back the hide. After durable commit,
the result remains successful even when cleanup/cancellation leaves a warning
and recoverable hidden path. Catalog enumeration excludes private staging.

Deleting an unrelated project keeps the existing epoch, native playing
connection, telemetry and command/status responsiveness. Deleting the loaded
project first admits the command, then revokes its epoch, joins source-bound
analysis/beat/envelope/alignment/search jobs and releases native connection
handles. Failure uses SourceResume to reopen the authoritative active path
paused, including private working-copy destination state. Recovery checks the confirmed original
folder before/after metadata reads, after native preparation and immediately before
adoption; a valid replacement at the old path is refused and prepared resources are
released. A rejected recovery enqueue clears the released song instead of leaving
stale loaded state. Success clears the
loaded song and prevents stale jobs/receipts from resurrecting it.

The loaded-song confirmation note follows the actual production handler:
deletion stops/closes the open song. It does not repeat older conflicting
"keeps playing" copy. Error feedback is inline and visible offline; the source
currently only displays that message in its Drive-configured branch. This is
an explicit correctness correction, not a claim of identical source copy.

`sync_dirty` records durable local deletion intent. Google Drive account setup,
upload, remote trash and remote reconciliation are not connected or verified.
Custom tracks, stem export and account synchronization remain separate scope.
The completed training-recording checkpoint is unchanged.

## Verification

| Check | Current result |
| --- | --- |
| Domain/backend/host/dialog compilation and Rust tests | PASS: 422 passed, 0 failed, 2 ignored; `/tmp/singz-project-delete-unit-final-v6.log` |
| Hidden UI v1 | Found a real duplicate-hover panic; shared button corrected |
| Hidden UI v2 | Actual unrelated-project playback advanced; metadata conflict preserved data and restored paused; later test-only Songs-toggle error corrected |
| Hidden UI v3 at 1280 | Complete flow passes: other-project deletion with advancing native status, metadata conflict/paused recovery, actual writer refusal, loaded deletion clear/no resurrection |
| Hidden UI v3 at 1060 | Found a real zero-height native grid; corrected by native intrinsic/shrink-0 section sizing, minimum 68 px rows and actual outer-page scroll |
| Final two-size hidden runtime v6 | PASS: `/tmp/singz-project-delete-ui-v6-driver.log`; 12 PNGs and four actual project deletions |
| Raw native full-frame comparisons | PASS: 84/84 final raw frames (18 screen, 17 training, 49 lyrics); strict reports retained in archive |
| Picker/library-import regression | PASS: real existing native workflows; driver logs retained |
| Final normal build | See archived final build log |
| Final source identities and archive publication | Source snapshots, dirty diffs, UI/helper hashes and recovery report retained |
| New production-matched visual/temporal references | Absent; no parity claim |
| Windows/Linux deletion execution | Unqualified |

The passed v6 driver uses actual card/confirmation input at both sizes and
covers duplicate Unicode project titles with independent directory identity, a
stems-only other project, native anchor/status/position advancement while unrelated
deletion is held busy, Keep/Escape/scrim/Tab focus and busy dismissal guards,
metadata-conflict preservation with paused recovery, real writer refusal, and
loaded deletion stop/clear with no resurrection after 350 ms of late callbacks.
Python independently verifies four deleted project directories, untouched external
and library sentinels, and the durable ledger's exact sequence 4 and four directory
entries. The ledger snapshot is retained as `durable-deletion-intent.json`.

The narrow-grid correction changes real native catalog layout: its section keeps
intrinsic height with shrink-0, rows have a 68 px minimum, and the outer page
actually scrolls to controls. The immutable demo fixture branch remains unchanged.
No receipt injection, direct UI-row replacement or relaxed hit-target assertion
substitutes for native control reachability. These new screenshots are not matched
production parity evidence.

Testing remains hidden and muted with app-local input and isolated fixtures.
Performance evidence contains 42 app-process CPU samples, median 64.13% and peak
101.25%, during the scripted workflow; it is not an idle benchmark and excludes
separate native helper processes. GPU observations are system-wide and hidden
live display FPS remains unmeasured. Physical playback quality, full platform qualification
and the complete desktop interface port remain open.

## Shared UIKit recovery

The sibling session checkout was unexpectedly absent during final verification.
Its cause is unknown. It was restored from its Git base plus archived tracked diff,
full archived Rust source, original Telegram asset and preserved font bytes. Seven
missing Mac faces were recovered byte-for-byte from the existing native binary;
Windows metadata aliases were derived and matched against the pre-existing hashes.
All 42 archived distribution font/assets hashes match, and all 32 native font faces
match their canonical manifest. No font was substituted. Sources before the late
recovery guards are retained separately. The user's running preview was untouched.

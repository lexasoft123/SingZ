# Native Drive Delete/Rename and name reuse — 2026-11-09

The native writer now retires the exact positively published generation after a
committed local Delete/Rename. Deleting the last project works without treating
an empty or unavailable library as general deletion authority. A later same-name
project receives a distinct cloud lineage. This is a local macOS/mock-Drive
checkpoint; the full desktop migration remains active.

## Authority and recovery

- Local operations capture account/root context, directory birth identity and
  the pre-operation document fingerprint before the exclusive filesystem move.
  Immutable prepared records and atomic dirty-ledger operation references
  distinguish committed moves from hints, failures and uncertain acknowledgements.
  Local recovery preserves collisions/newer Saves and runs independently of login.
  Invalid library preferences refuse Rename before moving, rather than silently
  treating the loaded selected-library project as external.
- Ordinary publication records fixed IDs, captured identity, planned hashes and
  changed-only immutable payloads before project HTTP mutation. Acceptance is
  serialized against local moves; no HTTP holds the project publication lease.
  Interrupted accepted uploads finish their own catalog-last positive boundary
  before a later Delete/Rename or Save is reconciled, even after source pruning.
  Complete admitted rosters preserve pre-existing unmanaged subfolders, including
  a folder sharing a managed filename; those folders remain outside ownership.
  Unknown added members, independent content/parent changes and cancellation
  retain the transaction without granting new deletion authority.
- Retirement journals bind exact operation sequences and positive source receipts.
  Rename waits for its positively published successor. Rename chains/cycles and
  terminal Delete witnesses do not acknowledge descendants ahead of an unresolved
  predecessor. Trash requires affirmative exact-ID proof; pending 404 is not proof.
  Catalog removal merges only the old row and preserves unrelated/unknown fields.
- Terminal retirement is replayable after remote trash retention ends. Its exact
  source closes the old empty journal without touching a newer same-name journal.
  Restored retired IDs, arbitrary replacements and unresolved names/rows remain
  protected from generic cleanup. Exact positively observed writer-pruned IDs
  remain provable; foreign trashed members are not ignored.
- Completing a waited-for successor explicitly schedules retirement and cleanup.
  Outstanding operation references remain dirty after directory hints clear.
  The UI reaches “up to date” only after the final clean receipt.
- Completed audio payload copies are collected only after durable Complete.
  Immutable metadata history is retained and validated without lifetime count
  quotas; large-history lookup/recovery tests exceed 4,096 receipts/transactions
  and 5,500 local operations. Metadata compaction and large-history scan performance
  remain separate work. Unsupported birth identity prevents persistent retirement
  authority while ordinary unguarded publication can still sync.

## Verified scope

- Frozen `integrated-v9`: **1,009 Rust tests passed, zero failed, two installed-model
  tests ignored**. UI-enabled test compilation, UI and normal builds pass.
  Compiled source, fonts and native helper hashes remain unchanged throughout validation.
  A later Python viewport selector changes no case action/assertion (equal case-body
  AST hash); the fixture-only delta is recorded.
- Final accepted cases `ui-v6/1280` and `ui-v7-compact/1060`: actual Sign in, final custom Remove, Header Save, Library Sync,
  sole-project Delete/confirmation, filesystem-fixture creation through the real
  ProjectPicker, typed Header Rename and same-name reuse. Both 1280×800 and
  1060×640 pass: two app launches and 20 content captures at 2× scale.
- Independent REST/journal assertions verify committed local authority, affirmative
  folder trash, catalog removal, fresh folder/document IDs, both retained recovery
  generations and eight protected recovery/outside objects per case. All terminal
  status checks use actual clean worker receipts. The missing-library guard remains.
- Foreground identity stays unchanged. All observed processes retire naturally,
  including ten observed native audio helpers; no input helper is opened.
  There are 185 error-free app CPU/footprint/system-GPU samples, no discarded
  terminal samples and no forced stops. Helper CPU is excluded; live FPS is unmeasured.
- All twenty full images were inspected. Wide dialogs, title editing, cards and
  status rows fit. Compact Saved/card titles abbreviate; the rightmost timeline
  tick is partially clipped beside zoom controls. Fresh-open includes entrance
  animation. These are candidate observations, not a production-reference parity,
  settled-opacity or smoothness verdict. The approved native lyric glow is unchanged.
- UI SHA-256: `6e02ffa2b5ddc378cae30f8bca6dece031397faa552c434ea4b795cb6a1959c8`.
  Normal SHA-256: `7dd9a5164de3ed160da7ae5dbb60b96086457cec96be2f2c36f8010c96d589a2`.
  Audio helper SHA-256: `829594dbc82098caba2b6d3896771b2e16a4aedf86b2d4c091838aa6363fd44b`.

Durable evidence: [gpui-retirement-drive-20261109](/Users/maxplanck/.codex/visualizations/2026/11/05/01a1add5-9a90-73c3-bec3-c18bfb04e619/gpui-retirement-drive-20261109).
It includes source/binary pins, full-suite/build logs, actual remote ledgers,
operation/retirement proofs, captures, resource/foreground/process observations,
and the earlier failures. No compiled binary or production OAuth configuration is
included. Earlier UI batches rejected foreground switches between external apps;
no guard was relaxed. The wide case passed in `ui-v6`; its compact failure was
not promoted. Only the compact viewport was retried, with all case assertions
unchanged, and both accepted cases use the same frozen binary/helper. The default
runner still requires both sizes. `integrated-v8` was intentionally interrupted
before tests to complete the related folder/file admission distinction. The automatic-rename test now observes its two scheduled
continuations with the existing twelve-second per-phase deadline.

## Remaining qualification

Real Google consent/account behavior, Windows/Linux execution of this lifecycle,
full-codec/configured delivery, physical audio/input, complete visual/temporal and
locale/accessibility parity, and release signing/notarization remain open.
The existing generic writer still reconciles its selected full library; a small
mock fixture is not authorization to test against an unrelated production account.
No Node/Electron, physical microphone, OS chooser or global input was used here.

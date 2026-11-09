# Training exercise, summary and history keyboard checkpoint

Exercise Exit, Replay, Skip, Continue and Identify answers now use persistent focus and shared UIKit Enter/Space activation. Summary Restart/Back and conditional Back to Song use the same control family. Recording joins the common focus order, replacing its separate activation binding. Callbacks recheck the currently mounted/enabled control and phase. A rendered phase change recovers focus when the previous answer, recording control or Retry disappears.

Progress and Summary support Home/End/PageUp/PageDown without song transport actions. Summary tracks its own scroll area and scrolls focused actions into view. History Save Retry is first in the logical tab order, matching its position before content; the previous mismatch could cycle Tab inside Training when a save error was visible.

## Verified scope

The final hidden macOS `ui-tests` binary has SHA-256 `eb9899fd1e5e062ce74b37e33e081b951c364b98d2ff616b620518443a8e668b`. It was built with UIKit commit `280d901cedc5611e60f891b074c6e90eef0f10a4`. All input is app-local; no window activation or global input is used.

- Normal cargo check, 13 training-domain tests and two shared range-policy tests pass.
- The new permanent journey passes 20 checks at 1280×800 and 1060×640, producing 14 PNGs and 18 native receipts. It covers Enter/Space single-answer receipts, Shift-Tab reversal, all five Identify answer layouts, removed-answer focus recovery, Restart/Back, actual fresh native A3 Replay, Skip, header pause/Continue and Exit.
- A private malformed preference document triggers a real worker save failure. Home and running Retry boundaries remain connected to the header; repairing that private document and pressing Enter retries successfully and recovers removed focus. The malformed bytes are preserved until explicit fixture repair.
- Filled Progress actually overflows and responds to End/Home at both sizes. The one-result Summary fits at both sizes; its bounded reading keys are checked, but this fixture does not qualify scrolling an overflowing Summary.
- The existing Home/setup journey passes all 19 checks on this binary, including actual native C4, replay-only CREPE scoring and owner release. The existing recording workflow passes at both sizes, including native record/stop, keyboard activation and exact WAV exports.
- All 17 static Training PNG pairs are pixel-identical to the preceding native build, and all six default capture sidecars match. The comparator self-tests pass. The compact interval grid and focused answer, summary and paused captures were inspected.

Private persisted length-one preferences shorten the exercise fixture. Generated PCM replaces hardware input only; cue rendering, capture ownership, CREPE and scoring remain native. The empty model catalog only suppresses installation UI; its fixture flavor does not qualify Linux. Output is muted and sync is disabled. No Node or Electron execution occurs.

## Resources and evidence

The new journey records 294 valid app CPU/footprint samples and system GPU observations, with zero errors or terminal discards. All 32 observed process identities retire naturally and foreground identity remains stable. App CPU averages 35.6%, with an 81.0% p95 during the scripted capture run; peak physical footprint is 430,163,288 bytes. These observations exclude helper CPU, and GPU is system-wide. Live FPS remains unmeasured for the hidden window.

The setup regression adds 65 valid samples and 11 retired observed identities; static pointer review adds four samples and one retired identity, with zero observer errors/discards and unchanged foreground in each run. The separate recording regression validates its own workflow and exports; it is not included in those strict observer totals.

Local batch: `/tmp/singz-training-running-keys-20261109`. Final cases are `ui-v2`, `setup-v2`, `recording-v2`, `review-candidate` and `comparison`. Source snapshots, build logs and earlier failures remain preserved. The first exercise run failed because its test inspected child controls before the queued answer updated the rendered phase; the corrected test waits for that actual transition before testing removal and Tab recovery.

The normal preview and durable evidence are published under `gpui-native-packages-20261108/macos-training-running-keys-20261109` in the session's visualization directory. Packaging qualification records the normal binary, payload hashes and ad-hoc signature separately from the UI-test binary.

## Remaining qualification

This native regression baseline does not establish production Electron visual parity. Conditional Back to Song activation, overflowing Summary autoscroll, all locales, platform/hardware audio, live display cadence, full temporal/accessibility parity and release qualification remain open. The normal preview is ad-hoc signed, not notarized. Training song-preparation controls still need a keyboard audit. The full desktop migration remains active.

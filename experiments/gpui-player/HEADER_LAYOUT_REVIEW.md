# Header layout follow-up — 2026-11-08

The narrow title editor now fits its available header slot, with both rounded
border ends visible. The compact Open control retains the full translated label
instead of applying an unnecessary second ellipsis. This changes only host header
composition in `src/header.rs`; the shared UIKit title control, tokens, fonts and
approved native lyric paint remain unchanged.

The production source authority is App.tsx's `.song-title` input and styles.css
`.title-input` (`min(360px,40vw)`). The host now caps the editor wrapper at that
preferred size and gives its child input the wrapper's actual width, allowing
flex layout to shrink it into the slot. Compact Open keeps intrinsic width and
no longer inherits the header's shrinking-label truncation. Other compact labels
retain their existing truncation behavior.

Mac normal and UI builds pass. Actual hidden/muted title interactions pass on
Mac and Dell at both 1280×800 and 1060×640 logical sizes (six PNGs each), preserving
Unicode saved rename, collision/external-edit refusal, Escape/Enter/blur, paused
and playing mix/position, library/search focus, loose-source title and Save. The
Mac locale workflow also passes: 59 PNGs, all fourteen language choices at both
sizes, English/Russian help/training/Log/popover cases, search and playback
continuity, rapid latest selection and Japanese restart. Foreground monitoring
remains unchanged throughout both Mac drivers and the Dell driver. Dell still
passes client/outer equality and all eight frameless resize codes; owned native
and GPU processes are retired and 18 owned scheduled tasks are terminal.

Reviewed full frames include Windows editing-1060, Mac editing-1280 and the
Russian selected-1060 header. The immutable before/after Windows full-frame
comparison finds 1,212 changed pixels in [1026,23,1378,78] physical pixels only:
the title's right border and Open text. The field previously lost its right edge
at approximately x=522 logical pixels; it now closes within the slot. Open now
shows its final n. Both full images, the overlay and difference image were read;
no masking, rescaling, threshold relaxation or baseline replacement occurred.
This compares native defect evidence, not a production reference, and is not a
production-parity pass. Other compact long-label truncation remains visible in
the Russian header and still needs matched production-reference review.

Candidate identities:

- Mac UI: `6670ec57bcb2d5d96f2abade6f5a524ee9058ddffbf27959a45df2759196f1d7`
- Mac normal: `a047ebcf34a499cd20a71b9bd656c18844ac14f006ef4536c628c44a1f37b19c`
- Dell UI: `95e0c23fa051740bfea2bac21c56a5c4f333395987c1985b7cd629df34361267`

The eight comparator self-tests pass. No full unit-suite rerun is attributed to
this host-layout-only change. The preceding four-workflow checkpoint remains
archived under its own older binary identity. Current source/remote source hashes,
build logs, foreground receipts, captures/state, raw CPU/RSS/GPU metadata, full
native diff and process-retirement receipt are in `gpui-header-fit-20261108` in
this chat's visualization directory. Live display FPS, actual physical devices,
Windows locale coverage, Linux integration and matched production visual/temporal
parity remain unqualified. No Node/Electron ran and the user's preview app was not
replaced. The full desktop objective remains active.

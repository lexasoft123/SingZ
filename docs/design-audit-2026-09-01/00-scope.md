# Scope — Rams audit of the SingZ lyrics editor

**Audited surface**: the lyrics editor modal and its entry points, as shipped on
branch `claude/lyrics-transcription-editor-58a312` at commit `aad6606`:
- `src/renderer/src/components/LyricsEditor.tsx` (modal, toolbar, rows, word strip)
- `src/renderer/src/lyrics-edit.ts` (pure logic feeding the UI)
- `src/renderer/src/styles.css` — the `.lyed-*` section (~line 4090 onward) and
  `.src-badge.edited`
- Entry points and badge in `src/renderer/src/components/LyricsPanel.tsx`
- Both platform treatments: liquid glass on macOS, solid `body.win` on Windows

**Rendered evidence** — screenshots of the running app on both platforms,
taken during the audit and not kept (they were session scratch; the
permanent driver `tests/e2e/mac/lyrics-edit-e2e.cjs` reproduces every one
of these states on demand):
- macOS at 3120×2000, on a song with no LRCLIB entry: the raw transcription
  with its silent "ghost" rows, the corrected lyrics under playback, and the
  word strip before and after the chip-readability fix.
- Windows at 2480×1640 on the QHD+ field rig, on a library song: the solid
  (no-blur) card with the strip open, the EDITED badge in the panel, and the
  themed scrollbar after its fix.

**Primary user**: a singer (often the song's own author) whose lyrics arrived
wrong — misheard words, hallucinated lines, timing that drifts.

**Primary task**: make the lyrics text true and the timing tight, then save so
every device shows the correction. Sub-tasks: delete hallucinated lines, paste
real lyrics, re-align automatically, stamp/drag times by hand down to the word.

**Constraints**: SingZ night-studio theme (kit tokens, Bricolage/Martian faces);
weak-iGPU fleet rules (`body.win` = no backdrop blur, no idle animations,
modal-open pauses background loops); desktop only; sentence-case friendly copy
that states sizes/time costs.

**References**: classic LRC editors (line tap-timing), DAW clip editors
(drag-on-waveform) — no direct competitor ships word-level lyric timing over a
vocals-only waveform in a karaoke app.

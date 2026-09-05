# Consolidated evidence (five subagent passes, audited at commit aad6606)

Anchors cited below as [S] structural, [V] visual, [C] copy & honesty,
[W] weight & friction, [A] accessibility. Full reports live in the session's
task outputs; this file keeps what the scorecard cites.

## Structure [S]
- 16 singleton controls + 4 per row + (1 + W) per expanded strip; two
  canvases carry no handlers. Max JSX depth 7 from Modal. 8 keyboard/pointer
  affordances with no element of their own (⌘Z/⇧⌘Z/⌘Enter/Enter/Backspace/
  arrows/paste/Esc).
- Duplication is almost entirely keyboard+mouse parity (stamp button vs
  ⌘Enter; Undo button vs ⌘Z; drag vs double-click vs arrows). Truly
  redundant: the strip hint span restates the chip tooltip verbatim
  (LyricsEditor.tsx:204 vs :244).
- Dead code: `listRef` attached, never read (LyricsEditor.tsx:279/:750);
  `ROW_VOICED_MIN`/`WORD_MIN_S` exported but only used internally;
  `wordDragBounds` exported for tests only. Redo exists only as ⇧⌘Z — no
  control names it (:622).
- 8 mode states across 3 slots (body ×2, footer status ×5, footer action ×2)
  plus strip/saving/dirty overlays.

## Visual [V]
- Colors: 27 of 28 expressions token-derived (1 raw: the card's black drop
  shadow). `.src-badge.edited` fully tokenized while its two siblings carry
  raw hex.
- Spacing: 15 distinct px values, 8 singletons (three from the card's
  asymmetric padding 22/26/18). Type: 7 sizes, 5 used once in-section; the
  row input (15px) and the replace-all textarea (14px) set the same content
  at different sizes.
- Footer wrap: with a long hint, "Save lyrics" wraps onto two lines —
  OBSERVED on both platforms in the audit screenshots.
- Strip hint `.lyed-ws-hint` (10px, --faint) ≈3.3:1 over the waveform and
  OBSERVED sharing pixel space with an odd-row word chip.
- States: empty = placeholder only; busy = text-only; error/success = same
  style as the idle hint (color-only for warn); word-chip focus style
  missing (kit outline clipped by `overflow: hidden`); NO dirty/unsaved
  indicator anywhere; confirm-discard present and neutral.
- Platform parity: body.win drops blur + flat fill exactly as designed;
  scrim solidifies; themed scrollbar confirmed after the fix.

## Copy & honesty [C]
- No dark patterns: consent states sizes before any download; "Not now"
  clean; discard confirm neutrally worded ("Keep editing"/"Discard").
- Inflations: "every line snapped to the singing" shows on 'retimed'
  verdicts where badLines were deliberately NOT snapped (align.ts:363-389 vs
  LyricsEditor.tsx:898); "the sharpest timing there is" (superlative,
  :679); "uses the AI transcription, so it's usually instant" can mean a
  1.6 GB download + full whisper pass on the cache-miss path.
- Jargon without in-place explanation: playhead, voiceprint, stamp,
  forced alignment, "Precise" as a bare adjective; error strings leak
  whisper-cli/"splitter pack"; "Transcription failed:" can carry 400 chars
  of raw stderr.
- Label→behavior: ⌘Enter named on Windows where the key is Ctrl+Enter
  (:761/:902); "Save lyrics" persists times the screen showed as "—"
  (linesFromRows invents them, lyrics-edit.ts:90-118); "try Precise" can point at
  a chip that isn't rendered (preciseCap gate :674); two Cancels visible
  during an align, one inert; `Cancelled.` never displayed; align on the
  cached path ignores Cancel; Align sets dirty so a user who typed nothing
  gets "Discard your edits?"; "· AI-aligned" badge is lost after saving an
  in-editor align; NumpadEnter doesn't stamp.

## Weight & friction [W]
- At the audited commit the editor shipped inside the 1,274,438 B raw /
  286,135 B gzip renderer entry (no lazy import; the split landed after).
  Editor's own weight ≈40,755 B raw / 9,972 B gzip as a chunk.
- Open cost (5.6-min stereo song): downmix 56.5 MiB allocation + 3 full
  passes over 14.8M samples + two sorts (~590k comparisons), synchronously
  inside a useMemo — blocks the modal's first paint, and re-runs on every
  open (deps [engine], component unmounts on close). Plus 30 RowPrint
  canvases: 30 getComputedStyle calls, 540 spanLevel + 540 fillRect.
- Zero network/IPC on mount; all four IPC calls are user-triggered.
- Idle: 0 infinite CSS animations in-section; background app loops paused
  via body.modal-open; ONE 60 Hz rAF loop runs even while paused
  (change-gated writes; O(rows) scan per frame). prefers-reduced-motion is
  not consulted anywhere in the section.
- Field-measured GPU (Dell HD 4600, two runs): karaoke 19.4/19.9% → editor
  open 7.4/8.0% → strip live 2.4/3.6%. The editor is cheaper than the
  screen it covers.

## Accessibility [A]
- Keyboard-reachable: play, align, precise, replace-all, drop-silent, undo,
  text edit, split, merge, stamp, row navigation, save, cancel, discard.
- NOT keyboard-reachable: row delete (only the hover-revealed ✕,
  tabIndex −1) and the word strip (only toggle is the tabIndex −1
  voiceprint button) — word chips have arrow-key nudges that a keyboard
  user can never reach.
- No focus trap in the kit Modal (Escape only); Tab exits into the app
  behind the scrim; nothing sets initial focus on open; focus drops to
  body when confirm-discard replaces the focused Cancel.
- No aria-live for align progress/verdict; 3 aria attributes total.
- Contrast (enabled, non-exempt) failures: ghost-row text ≈3.1:1, its
  stamp ≈2.8:1, strip hint ≈3.3:1, ✕ glyph ≈3.2:1. Everything else passes,
  most by wide margins.

## Corrections between agents
- [V] called `.lyed-word` a div; it is a `<button>` ([A] and source agree) —
  its focus finding survives via the clipped outline, not via
  unfocusability.

## Already addressed in-session (after the audited commit; noted, not scored)
- Footer pill wrap fixed; ⌘/Ctrl labels made platform-aware; a "?" help
  sheet now documents every gesture; play button gained title/aria-label;
  the editor moved out of the boot bundle (lazy).

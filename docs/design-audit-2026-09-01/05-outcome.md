# Outcome — redesign executed same-session

All five moves from 04-handoff-prompt.md landed in commit a3bcf2c (with the
help sheet, platform key labels, footer wrap and lazy split already in
bb0913c), verified where each is testable — see the coverage note at the
foot of this file rather than assuming the suite guards all five:

1. #6 — describeCheck generates every verdict string from verdict data
   (5 unit tests in tests/unit/lyrics-edit.test.ts); the permanent driver
   asserts on its own unhearable marker line that the verdict neither says
   "every line snapped" nor omits the line it could not hear. The EDITOR's
   tooltips lost their superlatives.
2. #8/#A — Tab contained in the card (kit trap still owed to @singz/ui,
   marked in-code); ⌘⌫ row delete, ⌘E strip open with chip focus, Esc peels
   help → strip → editor; initial focus; discard confirm keeps focus;
   busy Cancel disabled with a reason instead of silently inert.
3. #8/#V — aria-live status slot, determinate busy bar, amber dirty dot;
   ghost rows and ✕ raised to --dim; strip corner hint deleted.
4. #9 — envelope computed post-paint, cached per buffer (WeakMap);
   prefers-reduced-motion honored for the editor's two transitions.
5. #3 — one 15px size for lyric text in both views; dead listRef removed.

**What the suite actually guards.** Move 1 is pinned by the five
describeCheck unit tests plus the driver's overclaim assertion; move 2 by
the driver's help-sheet, ⌘E and ⌘⌫ steps. Moves 3, 4 and 5 (aria-live and
the dirty dot, the post-paint envelope, the single text size) have no
automated assertion — they were verified by hand against the running app
and would not fail a suite if they regressed. That is a known gap, written
down rather than papered over.

Not done here (tracked):
- The focus trap belongs in @singz/ui's Modal proper — this editor carries
  a local Tab containment, so every OTHER modal in the app still tabs out
  into the page behind the scrim.
- LyricsPanel's own copy was outside the audited surface and is unchanged:
  its lp-check verdict strings, and its Precise tooltip, which still calls
  that tier "sharpest timing" — the same superlative the editor's own
  tooltip dropped.

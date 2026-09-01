# Handoff — run this with /make-plan

````
/make-plan Redesign the SingZ lyrics editor's communication layer (copy,
state feedback, focus/announcement, and the open-path cost). Current design
failed a Dieter Rams audit at 19/30 with critical gaps in principles #3
(aesthetic, 1/3), #4 (understandable, 1/3), #6 (honest, 1/3), #8 (thorough,
1/3).

Verdict paragraph (quoted from the audit):
> The editor's bones — voiceprint rows, the word strip, draft-preview
> alignment, the measured-cheap solid/glass shell — are worth keeping
> exactly as they are; the layer that explains, claims, confirms and
> focuses needs to be rebuilt as one designed system instead of accreted
> strings and defaults.

Why redesign and not refine: total score 19/30 sits below the refine
threshold; four principles scored 1 for the same root cause — the feedback
layer was accreted per-feature, never designed as a system.

Preserve from current design (do NOT touch):
- The draft-rows + voiceprint + word-strip interaction architecture
  (src/renderer/src/components/LyricsEditor.tsx, RowPrint, WordStrip) and
  all pure logic in src/renderer/src/lyrics-edit.ts — scored 3/3 on
  innovation and usefulness; the permanent driver
  tests/e2e/mac/lyrics-edit-e2e.cjs is its regression net.
- The platform shell: liquid glass on mac, solid body.win card
  (styles.css .lyed-card + body.win override) — field-measured CHEAPER
  than the karaoke it covers (19.9% → 8.0% → 2.4% GPU on the HD 4600).
- Token discipline: 27/28 colors derive from kit tokens; keep it that way.
- The help sheet, platform-aware key labels, and lazy-loading (landed
  post-audit at commit bb0913c).

Discard (the structural patterns causing the failures):
- Claim-shaped status strings. "every line snapped to the singing" renders
  on 'retimed' verdicts whose badLines were deliberately NOT snapped
  (src/main/align.ts:363-389 vs LyricsEditor.tsx:898). Caused failure on
  principle #6.
- Tooltip-only understandability: playhead/voiceprint/stamp/"Precise" are
  explained nowhere in place (title attributes only). Caused failure on #4.
- Default-styled states: busy/success share the idle hint's style; dirty
  has no pixel at all; focus styling relies on the kit outline that the
  strip's overflow:hidden clips. Caused failure on #8 and #3.
- tabIndex={-1} as a layout convenience (row ✕ at LyricsEditor.tsx:833,
  voiceprint at :771) — it silently amputated keyboard access to row
  delete and the whole word strip. Caused failure on #8.
- Synchronous open-path analysis: the envelope useMemo
  (LyricsEditor.tsx:292-313 at aad6606) blocks first paint with 3 passes over 14.8M
  samples + a 56 MiB allocation, every open. Caused the #9 deduction.

Top moves from the audit (verbatim):
1. #6 honest — verdict strings that match the verdict: on 'retimed' say how
   many lines couldn't be heard and kept estimated timing; surface
   extraSung; drop "the sharpest timing there is".
2. #8/#A thorough — keyboard-complete and announce: Delete path for rows, a
   keyboard route into the word strip, focus-visible styles that survive
   overflow:hidden, a focus trap in the kit Modal, aria-live on the footer
   status slot, initial focus on open.
3. #8/#V thorough — state truth: a dirty indicator; busy visually distinct
   from the idle hint; fix the four sub-4.5:1 contrast spots (ghost rows
   ≈3.1:1, ghost stamps ≈2.8:1, strip hint ≈3.3:1, ✕ glyph ≈3.2:1 — all
   --faint at 10-15px).
4. #9 — compute the vocal envelope after first paint (or incrementally,
   cached per song); consult prefers-reduced-motion for entry animations.
5. #3 — one size for lyric text in both views (row input 15px vs replace
   textarea 14px); reserve a band for the strip hint so it can never
   collide with word chips.

Redesign principles in priority order:
1. #6 honest — every status string is generated from the verdict data it
   describes, so it cannot overclaim.
2. #4 understandable — a first-time singer can name every control without
   hovering; jargon either replaced or taught once in the help sheet.
3. #8 thorough — every state (dirty, busy, error, verdict, focus) has a
   designed pixel, reachable and announced without a mouse.

Deliverables for the plan:
- A status-string table: every (verdict × method × badLines/extraSung)
  combination with its exact copy, generated from data.
- Keyboard map covering 100% of editor actions, with the focus-trap and
  aria-live changes to @singz/ui's Modal called out separately (kit change,
  synced via the kit repo).
- Token/spec deltas in one place (contrast fixes, the one text size, the
  strip hint band).
- The envelope's async/cached compute design with its E2E guard.
- Regression checklist: the permanent driver stays green; the Dell GPU
  numbers stay at or under 8.0%/3.6%; the preserve list above untouched.

Anti-patterns to guard against (specific to REDESIGN):
- Porting the accreted strings under new styling — the table is the source.
- Keeping both feedback styles behind a flag.
- Redesigning the interaction architecture the audit scored 3/3 — the
  preserve list is not optional.
- Fixing contrast by brightening --faint globally (it is a shared token —
  scope changes to the editor's usage sites).
````

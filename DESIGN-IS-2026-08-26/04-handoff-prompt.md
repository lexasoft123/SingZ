# Planning handoff

```
/make-plan Redesign desktop Vocal Training. Current design failed audit at 16/30 with critical gaps in principles #3 aesthetic, #4 understandable, #6 honest, #9 environmentally friendly, and #10 as little design as possible.

Verdict paragraph (quoted from 03-verdict.md):
> The desktop Vocal Training flow needs a focused redesign—not a new visual identity—because its excellent automatic practice core is undermined by ambiguous tuner states, forced and contradictory feedback behavior, low-contrast microcopy, and duplicated presentation.

Why redesign and not refine: The total is below 20, and load-bearing clarity and honesty both scored 1 because visible labels and states do not consistently match behavior.

Preserve from current design (MUST be non-empty):
- The SingZ palette, typography tokens, and dark studio character in `src/renderer/src/styles.css:7-33`.
- The fixed, distance-readable target stage and automatic reference/sing/repeat flow in `src/renderer/src/styles.css:3847-3901` and `src/renderer/src/components/VocalTraining.tsx:564-584`.
- The overtone-aware 1.5-second pitch lock in `src/renderer/src/training-practice.ts:144-246`.

Discard (MUST be non-empty):
- Ephemeral detailed feedback plus forced 750ms continuation. Evidence: `src/renderer/src/components/VocalTraining.tsx:580-584,1134-1150`. Caused failure on principles #4 and #6.
- Duplicate and conflicting state signals: silent centered marker, duplicate target pill, repeated phase/status copy, repeated setup summary. Evidence: `src/renderer/src/components/VocalTraining.tsx:948-955,1043,1051-1054,1071,1088-1113`. Caused failure on principles #3, #4, and #10.

Top 3–5 moves from the audit (verbatim):
1. Principle #6 — Honest: Make Skip a distinct unscored/skipped outcome, and replace the unreadable 750ms detailed feedback screen with a compact result that remains visible during the next countdown. Evidence: `VocalTraining.tsx:263-286`, `507-510`, `580-584`, `1134-1150`.
2. Principles #3/#4 — Aesthetic and understandable: Remove the centered marker until voiced input exists, raise essential labels to at least 12–14px using an AA-contrast token, and replace specialist labels such as “Pitch window” and “Find it” with plain language. Evidence: `styles.css:3909-3917`, `3960-3968`, `4051-4056`; `VocalTraining.tsx:832-853`, `930-943`, `1088-1113`.
3. Principle #10 — As little design as possible: Remove the duplicate single-note sequence pill, redundant phase/status wording, repeated setup footer values, and overlapping tuner explanations. Evidence: `VocalTraining.tsx:948-955`, `1043`, `1051-1054`, `1071`, `1099-1113`.
4. Principles #5/#7 — Unobtrusive and long-lasting: Keep the SingZ palette and fixed target stage, but reduce blur/glow/card treatment to the header and transport only. Evidence: `styles.css:3656-3669`, `3793-3803`, `3875-3881`, `3928-3968`.
5. Principle #9 — Environmentally friendly: Lazy-load the training feature and measure renderer startup; cap blur surfaces and verify Windows GPU behavior. Evidence: `out/renderer/assets/index-DAuAvUp6.js`, `styles.css:3656-3669`.

Redesign principles in priority order:
1. Principle #6 — Honest — every label and visible state must map exactly to stored behavior and timing.
2. Principle #4 — Understandable — the singer should identify pitch state and every primary control from monitor distance without specialist vocabulary.
3. Principle #10 — As little design as possible — one dominant target, one pitch instrument, and only essential transport/status information.

Deliverables for the plan:
- New information architecture for Home, Setup, Countdown, Tuner, compact feedback, and Summary.
- New primary flow wireframe compared side-by-side with the current flow.
- States checklist: empty, loading, error, success, focus, disabled, interruption, silence, voiced, centered, skipped.
- Migration path preserving current persisted volume and pitch-tolerance settings.
- Cutover criteria: all label/behavior mismatches resolved, AA contrast for essential copy, no target movement between phases, automatic flow retained, and keyboard/Electron visual tests passing.

Anti-patterns to guard against:
- Porting the old structure under fresh styling.
- Keeping both designs behind a flag indefinitely.
- Redesigning to follow a trend rather than the principles above.
- Treating the Preserve list as optional.

Out of scope: mobile UI, pitch-DSP thresholds, organ timbre, song player, navigation architecture, and unrelated progress analytics.
```

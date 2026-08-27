# Verdict: REDESIGN

The desktop Vocal Training flow needs a focused redesign—not a new visual identity—because its excellent automatic practice core is undermined by ambiguous tuner states, forced and contradictory feedback behavior, low-contrast microcopy, and duplicated presentation.

## Highest-leverage moves

1. Principle #6 — Honest: Make Skip a distinct unscored/skipped outcome, and replace the unreadable 750ms detailed feedback screen with a compact result that remains visible during the next countdown. Evidence: `VocalTraining.tsx:263-286`, `507-510`, `580-584`, `1134-1150`.
2. Principles #3/#4 — Aesthetic and understandable: Remove the centered marker until voiced input exists, raise essential labels to at least 12–14px using an AA-contrast token, and replace specialist labels such as “Pitch window” and “Find it” with plain language. Evidence: `styles.css:3909-3917`, `3960-3968`, `4051-4056`; `VocalTraining.tsx:832-853`, `930-943`, `1088-1113`.
3. Principle #10 — As little design as possible: Remove the duplicate single-note sequence pill, redundant phase/status wording, repeated setup footer values, and overlapping tuner explanations. Evidence: `VocalTraining.tsx:948-955`, `1043`, `1051-1054`, `1071`, `1099-1113`.
4. Principles #5/#7 — Unobtrusive and long-lasting: Keep the SingZ palette and fixed target stage, but reduce blur/glow/card treatment to the header and transport only. Evidence: `styles.css:3656-3669`, `3793-3803`, `3875-3881`, `3928-3968`.
5. Principle #9 — Environmentally friendly: Lazy-load the training feature and measure renderer startup; cap blur surfaces and verify Windows GPU behavior. Evidence: `out/renderer/assets/index-DAuAvUp6.js`, `styles.css:3656-3669`.

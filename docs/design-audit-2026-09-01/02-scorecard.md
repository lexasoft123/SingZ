# Scorecard — SingZ lyrics editor at aad6606 (max 30)

Scoring rules applied: anchors verbatim, worst instance not the mean,
tie-break to the lower score.

1. Good design is innovative — Score: 3/3
   Evidence: word chips draggable on a vocals-only waveform inside a karaoke
   app; per-row voiceprints that make hallucinated lines confess by drawing
   flat; no peer product in the scope's reference scan ships either ([S], [V],
   00-scope references).
   Justification: advances the form (timing editing grounded in the singing
   itself) and ships it with restraint — one strip at a time, no decoration —
   rather than imitating LRC editors or DAWs.

2. Good design makes a product useful — Score: 3/3
   Evidence: fix-words flow is open → type/paste → align → save with zero
   decoy actions; every step of that path is keyboard-reachable [A]; the
   killer path (paste real lyrics over a wrong transcription → one-click
   align) was field-verified at 92% heard on the reporting user's own song.
   Justification: the primary task completes in the fewest possible steps;
   the gaps found (row delete, word strip) are secondary refinements and are
   charged to #8, not double-counted here.

3. Good design is aesthetic — Score: 1/3
   Evidence: three observed inconsistencies [V]: the row input (15px) and the
   replace-all textarea (14px) set the same content at different sizes;
   "Save lyrics" wraps onto two lines under a long hint (both platforms);
   the strip hint collides with odd-row word chips. Color discipline is
   otherwise near-perfect (27/28 token-derived).
   Justification: 3 minor inconsistencies lands in the 1 anchor band ("3–5
   inconsistencies"), not the ≤2 band — despite strong overall coherence.

4. Good design makes a product understandable — Score: 1/3
   Evidence: jargon present without in-place explanation (playhead,
   voiceprint, stamp, "Precise" as a bare adjective) [C]; the voiceprint
   button's function is not guessable from its looks; "—" chips and the
   whole word-timing capability were invisible without reading tooltips;
   ⌘Enter named on Windows.
   Justification: more than 2–3 controls need a tooltip and jargon is
   present — the 1 anchor verbatim. (The post-audit help sheet exists
   because of exactly this.)

5. Good design is unobtrusive — Score: 3/3
   Evidence: rows are the figure, chrome recedes; the studio stays visible
   through the glass; measured on the weakest fleet GPU the editor costs
   LESS than the screen it covers (19.9% → 8.0% → 2.4%) [W].
   Justification: chrome that literally reduces the machine's work while
   open is the strongest form of receding.

6. Good design is honest — Score: 1/3
   Evidence: two inflations [C]: "every line snapped to the singing" shown
   on 'retimed' verdicts whose badLines were deliberately not snapped;
   "the sharpest timing there is". No dark patterns anywhere — consent
   states sizes, discard confirm is neutral.
   Justification: 2 inflations hits the 1 anchor ("2+ inflations"), even
   with the dark-pattern slate clean.

7. Good design is long-lasting — Score: 2/3
   Evidence: mono timestamps, waveforms, kbd caps are timeless studio
   vocabulary; the liquid-glass treatment is the platform's current design
   language [V].
   Justification: one arguable trend marker (glass) — it tracks the host
   OS rather than a fad, but "reads as current in 3 years" is not certain;
   tie-break lands on 2.

8. Good design is thorough down to the last detail — Score: 1/3
   Evidence: word-chip focus visibility missing (kit outline clipped by
   overflow:hidden); no dirty/unsaved indicator; no aria-live for align
   status; row delete and the word strip unreachable by keyboard; four
   sub-4.5:1 contrast spots in enabled states [A][V].
   Justification: more than 2–3 states/details missing — the 1 anchor —
   even though empty/loading/error/success/disabled/confirm all exist.

9. Good design is environmentally friendly — Score: 2/3
   Evidence: zero idle animations, background loops paused by modal-open,
   measured GPU cheaper than baseline on the fleet's weakest iGPU [W]; but
   at the audited commit the editor rode in a 1.27 MB entry bundle, the
   open path does 3 synchronous passes over 14.8M samples with a 56 MiB
   allocation before first paint, and prefers-reduced-motion is never
   consulted.
   Justification: measured energy behavior is exemplary and motion is
   gated (the 2 anchor), held back from 3 by the blocking open cost,
   the bundle placement, and reduced-motion.

10. Good design is as little design as possible — Score: 2/3
    Evidence: duplications are keyboard+mouse parity that earn their place
    [S]; genuinely removable: the strip hint span restating the chip
    tooltip, and the dead listRef.
    Justification: ≤2 removable elements — the 2 anchor; not 3 because
    removable elements exist at all.

TOTAL: 19/30

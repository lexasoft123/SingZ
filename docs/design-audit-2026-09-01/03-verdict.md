# Verdict

**REDESIGN — scoped to the communication layer.** Total 19/30 with no zero
scores puts this below the 20-point REFINE threshold, but the failures
concentrate entirely in how the editor *talks* (#3 aesthetic 1, #4
understandable 1, #6 honest 1, #8 thorough 1) while its interaction
architecture scored the maximum on innovation, usefulness and
unobtrusiveness — so what gets redesigned is the feedback/copy/state layer,
and the structure underneath is explicitly preserved.

One-sentence verdict: the editor's bones — voiceprint rows, the word strip,
draft-preview alignment, the measured-cheap solid/glass shell — are worth
keeping exactly as they are; the layer that explains, claims, confirms and
focuses needs to be rebuilt as one designed system instead of accreted
strings and defaults.

Post-audit note (not scored): four findings were already fixed between the
audited commit and this verdict — platform-aware key labels, the help
sheet (a direct answer to #4), the footer pill wrap, and the play button's
accessible name. The moves below are what remains.

## Highest-leverage moves

1. **#6 honest — verdict strings that match the verdict.** "every line
   snapped to the singing" must not show when badLines were interpolated
   (align.ts:363-389 vs LyricsEditor.tsx:898): on 'retimed' say how many
   lines couldn't be heard and kept estimated timing; surface `extraSung`;
   drop "the sharpest timing there is" for what Precise actually is.
2. **#8/#A thorough — keyboard-complete and announce.** Row delete and the
   word strip are mouse-only (tabIndex −1 at LyricsEditor.tsx:771/:833);
   give rows a Delete path, make the strip openable from the keyboard, add
   focus-visible styles that survive the strip's overflow:hidden, a focus
   trap in the kit Modal, aria-live on the footer status slot, and initial
   focus on open.
3. **#8/#V thorough — state truth.** Add a dirty/unsaved indicator (state
   exists at LyricsEditor.tsx:264, no pixel shows it); give busy a visual
   distinct from the idle hint; fix the four sub-4.5:1 contrast spots
   (ghost rows, ghost stamps, strip hint, ✕ glyph — all --faint at small
   sizes).
4. **#9 environmentally friendly — unblock the open.** The envelope memo
   (LyricsEditor.tsx:292-313 at aad6606) does 3 passes over 14.8M samples + a 56 MiB
   allocation synchronously before first paint, on every open — compute it
   after first paint (or incrementally/cached per song), and consult
   prefers-reduced-motion for the entry animations.
5. **#3 aesthetic — one text system.** The row input (15px) and replace-all
   textarea (14px) must set lyric text at one size; reserve a band for the
   strip hint so it can never collide with word chips (styles.css:4343/4364
   vs :4381-4382).

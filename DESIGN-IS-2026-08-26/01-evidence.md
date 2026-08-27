# Evidence

## Measurements

- Captured at 1200×900: Home, Setup, Countdown, and Tuner (`/tmp/singz-vt-desktop-visual-*.png`).
- Feature interaction counts: Home 7; Single-note Setup 18; Countdown 1; Tuner 3 (`VocalTraining.tsx:715-735`, `813-961`, `1041-1073`).
- Visible type scale includes 8.5, 9, 9.5, 10, 10.5, 11, 11.5, 12, 12.5, 13, 15, 16, 17, 20, 22, 25, 29, 30, 32, 34, 52, 76, and 126px (`styles.css:2768-4117`).
- Small `--faint` text is approximately 3.05:1 over the glass panel, below WCAG AA for normal text. It is used at 8.5–11.5px in setup help, tuner labels, transport labels, and privacy copy (`styles.css:2916-2920`, `3078-3083`, `3909-3917`, `4051-4056`).
- Initial renderer bundle: 1,285,709 bytes JS raw / 286,049 gzip-equivalent; CSS 100,122 bytes raw / 25,217 gzip-equivalent (`out/renderer/assets/index-DAuAvUp6.js`, `index-D_RjzK0L.css`).
- No external network requests or idle animation were found. Runway and hold motion are event-driven and reduced-motion gated (`styles.css:4114-4117`).
- All native primary controls are keyboard reachable and have a 2px focus-visible outline (`styles.css:2760-2766`). No skip link is present.
- Empty, loading, error, success, focus, disabled, interruption, and summary states exist, although not all were screenshot-tested (`VocalTraining.tsx:741-768`, `947`, `1014-1191`).

## Per-principle evidence

1. Innovative
   - Target-relative overtone folding, median smoothing, a tolerance window, and sustained pitch lock form a restrained improvement over a basic tuner (`training-practice.ts:144-246`).
   - The visible primitives—countdown, sliders, glass cards, and transport—are established patterns.

2. Useful
   - A default user chooses an exercise, presses Start practice, then advances automatically through reference, singing, and the next prompt (`VocalTraining.tsx:564-584`, `961`).
   - The 126px target, 76px countdown, 126px runway, Replay, and Skip directly support hands-free practice (`styles.css:3875-3901`, `3928-3968`, `4025-4073`).
   - Pitch success is explicit: selected tolerance plus a 1.5-second hold (`VocalTraining.tsx:1108-1112`).

3. Aesthetic
   - Palette, typography, and surfaces follow shared SingZ tokens (`styles.css:7-33`, `3642-3690`).
   - The surface uses at least three inconsistent details: sub-12px low-contrast metadata, a duplicated single-note pill and hero, and repeated border/shadow/blur/glow treatments (`styles.css:3733-3785`, `3862-3881`; Tuner screenshot y163–351).
   - One error color still bypasses the token system (`styles.css:3085-3101`).

4. Understandable
   - Setup is grouped into Musical context, Comfortable range, and Common practice settings (`VocalTraining.tsx:818-945`).
   - “Find it,” “Pitch window,” “Voiced,” “Stable,” “tonal home,” and several diatonic labels require specialist knowledge (`VocalTraining.tsx:832-853`, `930-943`; `training-ui-state.ts:518-597`).
   - The silent marker is positioned on exact center while the message says “Waiting for your voice” (`VocalTraining.tsx:1088-1103`; `styles.css:3960-3968`).

5. Unobtrusive
   - Countdown reduces the feature to one action and ample negative space; singing reduces it to Replay, status, and Skip (`VocalTraining.tsx:1041-1073`).
   - Persistent shell status, multiple glass panels, glow, grain, chip, marker, and transport remain visible simultaneously (`styles.css:3656-3669`, `3875-3881`, `3928-3968`, `4025-4073`).

6. Honest
   - Tolerance, hold duration, note count, range, microphone-off Identify behavior, and settings persistence match implementation (`VocalTraining.tsx:848-855`, `906-961`; `training-practice.ts:3-8`).
   - “Skip” actually scores an attempt with missing one-millisecond target windows; it can be reported as “No steady voice was detected” (`VocalTraining.tsx:263-286`, `507-510`; `training-ui-state.ts:599-610`).
   - Feedback says “continue when ready” but is removed automatically after 750ms (`training-ui-state.ts:592-595`; `VocalTraining.tsx:580-584`).
   - “Start practice” in empty Progress only navigates back to Home (`VocalTraining.tsx:615-617`, `753-755`).

7. Long-lasting
   - Stable music terminology and shared kit tokens should age well (`VocalTraining.tsx:122-137`; `styles.css:7-33`).
   - Heavy glass, backdrop blur, surface glow, and pill styling are a visible contemporary trend marker (`styles.css:3656-3669`, `3793-3803`, `3928-3968`).

8. Thorough
   - The implementation covers empty, loading, error, success, focus, disabled, reduced-motion, persistence, and microphone interruption paths (`VocalTraining.tsx:741-768`, `947`, `1014-1191`; `styles.css:4114-4117`).
   - Detailed feedback is structurally present but cannot normally be consumed in its 750ms lifetime (`VocalTraining.tsx:580-584`, `1134-1150`).
   - Generic `div` elements receive `aria-label` without a group/region role (`VocalTraining.tsx:715`, `1051`, `1069`).

9. Environmentally friendly
   - No external requests or idle animations were observed.
   - The initial renderer ships 1.286MB raw JS, and Vocal Training adds 7 blurred home surfaces, 4 setup surfaces, and 3 tuner surfaces (`styles.css:3656-3669`).

10. As little design as possible
   - Automatic flow removes repeated confirmation clicks (`VocalTraining.tsx:564-584`).
   - Removable duplication includes the single-note sequence pill, repeated phase wording, repeated setup key/range footer, and overlapping tuner explanations (`VocalTraining.tsx:948-955`, `1043`, `1051-1054`, `1071`, `1099-1113`).
   - CSS retains two Vocal Training layers; 45 `.vt-*` exact selectors are declared more than once (`styles.css:2768-3639`, `3642-4118`).

## Known gaps

- No screen-reader session, performance trace, Windows rendering capture, physical-distance test, or light-theme audit was performed.
- Only the default single-note waiting state was captured; sharp, flat, on-target, feedback, summary, interval, error, and disabled screenshots remain unverified.
- Audio timbre and detector accuracy are outside this visual audit.

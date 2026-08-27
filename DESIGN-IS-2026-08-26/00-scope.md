# Desktop Vocal Training design audit scope

## Audited artifact

- Desktop Vocal Training exercise selection, single-note setup, automatic countdown, and live tuner.
- Repository: `/Users/maxplanck/Dev/my/SingZ/.Codex/worktrees/vocal-training`
- Primary component: `src/renderer/src/components/VocalTraining.tsx`
- Styling: `src/renderer/src/styles.css`
- Behavior: `src/renderer/src/training-practice.ts`, `src/renderer/src/training-ui-state.ts`
- Rendered evidence: `/tmp/singz-vt-desktop-visual-home.png`, `-setup.png`, `-countdown.png`, and `-tuner.png`, all captured at 1200×900.

## User and task

- Primary user: a singer using SingZ hands-free at normal monitor or music-stand distance.
- Primary task: choose an exercise, hear the reference, then settle and hold the requested pitch without unnecessary clicks.

## Constraints

- Preserve the existing SingZ dark studio palette and token system.
- Electron + React desktop stack.
- Match the mobile Vocal Training behavior where it improves continuity.
- Keep the target note readable from a distance.
- Audit only in this pass; do not implement changes.

## References

- Existing SingZ player visual language.
- The current mobile Vocal Training flow and its large fixed note stage, pitch-window setting, countdown, and replay/skip controls.

# GPUI prototype UI review

For interface-port implementation and UI parity work, use the
[interface-port-review skill](../../.agents/skills/interface-port-review/SKILL.md).
Read its full review procedure before changing ported UI.

- The current built production Electron interface is the reference.
- Match fixture, content viewport, scale, fonts, state and exact animation time before comparing.
- Capture in hidden windows; no foreground activation or global mouse/keyboard automation.
- Read full screenshots, overlays and differences; fix causes, rebuild and recapture until the required cases match.
- Put reusable controls and visual tokens in `../../../singz-ui/gpui`, not screen-specific copies.
- Missing states/captures, differing fixtures and unmeasured performance are not passes.
- Keep baselines immutable within a batch. Do not loosen thresholds or mask defects to pass.
- Report remaining differences explicitly. Do not claim pixel-perfect parity from interaction smoke tests.

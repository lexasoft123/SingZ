# Training Home/setup keyboard checkpoint

Home cards, program levels, setup selectors, task/interval/chord choices and ranges now support native keyboard navigation. Shared focusable range controls live in `singz-ui/gpui`. Focus scrolls within the measured body above the sticky footer; overflowing selectors open above their trigger. Popup measurement preserves absolute positioning.

Validation on macOS, 2026-11-09:

- Normal cargo check, 13 training-domain tests and two shared range-policy tests passed; UI-test build passed.
- Hidden native journey passed 19 checks at 1280×800 and 1060×640, producing ten captures and ten native receipts. It exercises all seven setup routes, selectors, limits, autoscroll, actual C4 cues, Start, real CREPE/scoring from generated A3 PCM, Identify without capture, and owner release.
- Private persisted length-one preferences shorten the exercise fixture. PCM replay replaces hardware capture only. Output remains muted; foreground is monitored. No Node or physical microphone is used.
- Existing native pointer regression passed; all 17 PNGs are byte-identical to the preceding native build. Both open Length-menu captures were inspected and keep the highlighted last option above the sticky trigger within the window.
- Staged app and UIKit review reported no findings.

Local evidence: `/tmp/singz-training-keys-20261109/ui-v4`, `review-reference`, `review-candidate-v3`, and `comparison-v3-summary.json`. UI binary SHA-256: `958bf17b4e24f83e3f2d3d14f76f798f95a838dc5df80b0b18ae0776b2eb59a9`.

Limits: this is a draft source checkpoint. The previous native build is a regression baseline, not proof of Electron visual parity. Running Identify answers and summary Back use app-local pointer input; their keyboard migration remains open. Live FPS, physical audio, other platforms and release qualification remain open. The packaged normal preview has not been refreshed for this checkpoint. Earlier failed attempts are retained locally, including the selector positioning regression now corrected.

Follow-up: exercise/summary activation and history navigation are implemented and qualified in [Training exercise keyboard review](TRAINING_RUNNING_KEYBOARD_REVIEW.md), which also refreshes the packaged normal preview. The remaining limits there supersede the running-keyboard and preview gaps recorded above.

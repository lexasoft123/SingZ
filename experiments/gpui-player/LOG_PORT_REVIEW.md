# Native Log dialog — initial screen port

The header Log route opens a native modal over catalog/player. Layout comes from production
`LogPanel.tsx` and `.log-*` CSS: 860px card, 22px/24px padding, 240px minimum body, 11px mono
rows at 1.7 line height, shared modal material/buttons/selectors/scrollbar. Text selection
uses GPUI Kit's existing selectable text/window layer. No bespoke common controls added.

Normal data starts empty. Copy uses the actual shown rows and resets its acknowledgement
after two seconds. Save explicitly reports that file persistence is disconnected. Fake
engine events, past sessions and messages are confined to the `ui-tests` fixture.

## Verification and evidence

- Normal and `ui-tests` builds pass; full hidden regression smoke passes.
- Dedicated Log checks pass at 1280×800 and 1060×640, scale 2: empty/12-row captures,
  actual row text selection, visible past-session option click, Close, popup-first Escape
  and outside-scrim dismissal. Clipboard is untouched by automated tests.
- Source reference is the rebuilt Electron app in an isolated profile, hidden/muted,
  sync disabled, forced sRGB. IPC serves declared fixtures; unrelated live log events are
  suppressed. No UI is fabricated in HTML. Foreground application is unchanged.
- Durable evidence (source/candidate PNGs, sidecars, hashes and strict diffs):
  `/Users/maxplanck/.codex/visualizations/2026/11/05/01a1add5-9a90-73c3-bec3-c18bfb04e619/gpui-log-port/`.
- Reference `/tmp/singz-log-port-reference-2`; candidate `/tmp/singz-log-port-native-6`.
  `native/review-manifest.json` identifies tested binary and source hashes independently
  of subsequent normal-build output. Popup screenshots additionally show the deferred menu.

## Visual verdict: changes still required

All four strict full-screen comparisons differ; **zero cases certified pixel-perfect**.
At 1280, mean absolute channel errors are 0.154164 (empty) and 0.919196 (rows); at 1060,
0.193647 and 1.349352. Full screenshots, overlay and difference images were inspected.
Existing background/grain/blur raster differences contribute to full-window mismatches;
row source-column advance and text/baseline differences remain visible in the overlay.
The counter color was corrected from DIM to the source FAINT token. Do not hide remaining
pixels by aligning, masking or changing comparator thresholds.

Real persisted log history/live subscription/file saving are deferred to backend integration.
Long/unbroken and non-Latin rows, large-history follow-scroll behavior, session-menu source
parity and clipboard confirmation timing still need dedicated coverage. Live FPS is
unmeasured. This commit starts missing-screen porting; it does not complete that inventory.

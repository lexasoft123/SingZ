# Song preparation keyboard checkpoint

The four loaded-song preparation choices now use shared UIKit focus and Enter/Space activation. Their tab order precedes the program controls and follows any leading Save Retry. Activation rechecks the mounted Home route, absence of a run, song presence and current audio-or-missing-key eligibility. Selecting a recipe still opens setup; Start remains explicit.

## Native journey

The final hidden macOS UI-test binary has SHA-256 `92acce10c5c6c5108c6ab3d4cc2c328860c15d4cd5c7ba859a9589b5f4ea2956`, using UIKit commit `280d901cedc5611e60f891b074c6e90eef0f10a4`. The permanent `test_native_training_song_keyboard.py` journey passes 16 checks at 1280×800 and 1060×640, with 16 captures and ten lifecycle receipts.

Normal cargo check, all three recipe-policy tests, normal/UI builds and strict package verification pass.

- Private generated songs are opened through the production `open_project` test seam. Actual Tab reaches the header, player transport, all four recipe choices, setup fields, answers and Back to Song. This does not qualify catalog admission or an OS file chooser.
- The known fixture has a current B-minor key stamp and transpose +2. Each recipe uses effective D-flat minor while preserving the range 49–73 and Identify task chosen through actual keys. Chords, Mixed, Intervals and Notes retain their source lengths 6, 8, 6 and 6 for Identify.
- Recipes stop at setup without cues or capture. The Notes recipe then completes all six actual Degree Identify prompts at each size, alternating Enter/Space. Each prompt has a fresh native cue containing its actual target, followed by exactly one correct receipt. No configuration, prompt or focus assignment shortens the recipe.
- Back to Song activates with Enter at 1280 and Space at 1060. It returns to the same retained source, paused. An explicit native Play advances position by more than 0.15 seconds while keeping transpose +2, tempo 1 and the 12-second duration; explicit Pause stops it again. Muted native master gain is observed as zero.
- Replacing the song while preparation setup is open revokes the previous context. A stale saved key cannot authorize a transposed key; choosing a recipe opens manual setup with the confirmation notice. Project metadata, lyrics and source PCM hashes remain unchanged.
- The compact six-result Summary genuinely overflows by 91.4 logical pixels. Tab to Back to Song scrolls by 63.4 pixels and keeps its bounds inside the viewport. This qualifies that concrete overflow/focus case, not every long Summary.

Generated A3 PCM is present only as a safety seam if capture regresses. The observer requires **zero input helpers** for this Identify-only journey, and all state records keep capture Off with no microphone intent. Output is muted, sync disabled and storage/cache/TMP private. No Node, Electron, physical microphone, global input or foreground activation is used.

## Regression and performance evidence

The same production source passes the existing 19-check Home/setup and 20-check exercise/history keyboard journeys. Those ran on UI binary `d2e37ca4d51ea2f331c5b55c8546453e0970f816c5f612f0cab3b2ec38b2a8fa`. The final UI build differs only in the song-test adapter: its focused Home capture now returns to the recipe buttons after checking the bottom tab boundary. The final song journey was rerun in full after that correction.

All 17 final static native Training PNG pairs are pixel-identical to the preceding native checkpoint, and all six default sidecars match. Eight comparator self-tests pass. The focused recipe, manual-key and six-result Summary views were inspected. These native regression pairs do not establish production Electron parity.

The final song journey has 139 valid app CPU/footprint samples, zero observer errors/discards, system GPU data for every sample, stable foreground and eight naturally retired observed identities. App CPU averages 30.2%, with a 79.8% p95; peak footprint is 447,366,512 bytes during scripted captures. Helper CPU is excluded, GPU is system-wide and live FPS is unmeasured.

Setup contributes 67 valid samples and 11 retired identities; exercise/history contributes 295 samples and 31 identities. Their observer error counts are zero. Setup discards one resource read only after confirmed process exit. Final static review has four valid samples, two retired identities and one confirmed-exit discard. Foreground stays stable in every run.

Batch: `/tmp/singz-training-song-keys-20261109`. Final song evidence is `ui-v2`; regression evidence is `setup-v1`, `running-v1`, `review-candidate-v2` and `comparison-v2`. Earlier captures, both source snapshots and binary identities remain preserved. The normal preview and durable evidence are under `gpui-native-packages-20261108/macos-training-song-keys-20261109` in this session's visualization directory. Packaging records normal-binary and payload hashes separately, with strict ad-hoc signature verification.

## Remaining scope

Full production visual/temporal and accessibility parity, all locales, unavailable-audio recipe eligibility, additional Summary lengths, hardware audio, Windows/Linux scenarios, live FPS and release readiness remain open. The normal preview is ad-hoc signed, not notarized. The full desktop migration remains active.

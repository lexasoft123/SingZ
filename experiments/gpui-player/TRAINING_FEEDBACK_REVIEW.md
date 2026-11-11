# Native Training feedback checkpoint

The native exercise now reveals completed Identify answers, retains the last
acknowledgement through the next prompt, and includes the final result in Summary.
Feedback uses the existing locale dictionaries and a shared UIKit banner. Signed
pitch summary copy is separate from the existing absolute scoring metric. Cue
timing, scoring, receipts and hardware ownership are unchanged.

Header controls use shared UIKit activation for actual keydown/keyup pairs. This
fixes the language menu opening and closing on a single Enter. The title pencil
also has persistent keyboard focus. Header monitoring focus recovery is reviewed
alongside these changes. Disabled/unmounted monitoring controls recover to
Settings synchronously only while their exact handle still owns focus. The
Training keyboard Stop → owner release → ordinary Tab sequence still needs
a permanent end-to-end check; current monitor coverage uses pointer Stop on Player.

## Evidence and limits

The final source includes the synchronous Header monitor focus recovery. Its
normal check, full suite (880 passed, zero failed, two ignored; 12.46 seconds)
and UI-feature build pass. The final UI binary SHA-256 is
`bb78d9b02de22a6cf3cb201bd5bf550fbd340bc8aae6cf15bd839b772b809a00`.


`ui-final/fixture.json` and the final title driver both pass against that final
binary. The feedback run retains all 14 checks, 28 captures, 12 receipts and eight
native replay Respond prompts. `title-final/result.json` confirms keyboard pencil
activation and the existing real backend journey. Both observers report unchanged
foreground and no sampling errors; all observed processes retire naturally.

The initial qualified candidate is SHA-256
`3a622494694d75b24d65a00f3b5b4ce0eb2c1dfb6e04e4081dcae4063d07618b`.
Artifacts are under `/tmp/singz-training-feedback-20261109`.

- `ui-v7/fixture.json`: passed. Actual EN/RU language controls at 1280×800 and
  1060×640; 28 captures, 12 lifecycle receipts and eight real native vocal Respond
  prompts. Generated A3 PCM replaces hardware capture; native cues, CREPE and
  scoring remain real. Wrong/correct answers use distinct targets; future answers
  remain hidden. Summary completion is checked against persisted receipts.
- `title-v1/result.json`: `keyboardPencilOpen=true`; the real project rename,
  collision, playback, external conflict and explicit Save journey completes.
- `combined-v1/result.json`: both native first/restart launches pass, with 52
  main captures plus four timeline-motion frames. The pre-recovery binary below
  covers native Save/restart, graph admission, transport/mixer/metronome/footer
  keys, catalog, region, output and countdown. Its 717 resource samples have no
  sampling errors, foreground stays unchanged and observed processes retire.
  This uses Header entity events for navigation, not measured Header clicks.
- `full-tests-v4.log`: 880 passed, zero failed, two installed-model tests ignored.
  Normal check and UI-feature build pass. A later source revision requires its own
  build and regression result; the candidate identity above remains immutable.
- Retained acknowledgement previously crowded the vocal dock. Its surrounding
  target stage now shrinks within the source minimum; text, banner, runway and
  dock retain their dimensions. Both sizes and locales pass geometry assertions.
- Test-only capture inspection distinguishes default Starting/Stopping intent
  placeholders from populated native capture data. Populated data still requires
  fixture proof; every vocal Respond proves replay and final Off retirement.

Earlier failed builds, a restricted-sandbox suite, failed geometry capture and
Python validator failures remain in the evidence directory. No scoring deadline,
comparison threshold or source assertion was weakened. The historical intermittent
shell-fixture timeout remains unresolved despite subsequent passing suites.

No Node/Electron execution or reference capture was used. These are native
functional and regression checkpoints. Complete production visual/temporal parity,
platform accessibility announcements, all locales, physical audio, Windows/Linux
qualification and live FPS remain open. The normal packaged preview is not
refreshed by this draft source checkpoint. See [acceptance gaps](DESKTOP_ACCEPTANCE_GAPS.md).

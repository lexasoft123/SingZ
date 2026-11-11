# Q-05 coverage: native open, edit and settings drivers

Build: `cargo build --profile qualify --features ui-tests` (aarch64 Mac, hidden window,
`SINGZ_MUTE=1`, `SINGZ_GPUI_BACKGROUND=1`), commit 8cfcc94d plus the Q-05 hooks. The audio helper was built
with `scripts/build-gpui-audio.sh <out> --basic-only` next to the app. Every driver copies the bundled sample
song (`mobile/assets/sample`, six FLAC stems) to a temp library, has per-step budgets and a total deadline, and
kills the app's process group on expiry. Each hook is a `ui_<name>.rs` behind `cfg(feature="ui-tests")`, one mod
line and one dispatch line in `main.rs`. `integration.rs` is untouched.

| Electron driver | Native driver | Hook | What it proves |
|---|---|---|---|
| `open-steps-e2e.cjs` | `tests/test_native_open_steps_ui.py` | `ui_open_steps.rs` | First, replacement and re-open report step times; reported project is exactly the folder asked for (path, name, 6 lane slots, duration); no helper decode (`--measure-input`, `--vocal-envelope`, `--render*`) and no analyzer start (logging wrapper around the helper); fixtures byte-identical afterwards |
| `bar-edit-e2e.cjs`, `redetect-bars-e2e.cjs` | `test_native_bar_edit_ui.py` | `ui_bar_edit.rs` | Real ruler drag saves one beat-aligned user bar folded into `downbeats`, `source` stays `auto`; popover counts it ("1 hand-set bar"); real Re-detect runs the detector once, applies a different bar phase, keeps the bar live and, after Save, on disk (within 0.3 s), still `auto` |
| `wizard-consent-e2e.cjs` | `test_native_first_run_ui.py` | `ui_first_run.rs` | Wizard lists splitter / speech / aligner, aligner and splitter not installed, speech installed; opening it starts nothing; Close returns to the open song; Precise shows an aligner consent with the aligner size; a `curl` shim on PATH and the model/pack directories prove nothing was fetched or written |
| `audio-devices-e2e.cjs` (persistence legs) | `test_native_settings_relaunch_ui.py` | `ui_settings_relaunch.rs` | Three processes over one config dir: real clicks choose output channels 7/8, file written; relaunch shows the same labels and does not rewrite `audio.json`; with the device gone Settings reports it unavailable and the file keeps the choice |
| `space-focus-e2e.cjs` | `test_native_space_focus_ui.py` | `ui_space_focus.rs` | Real mouse clicks then Space: after Mute, Space plays/pauses and Mute unchanged and unfocused; after a fader click Right moves the fader without seeking, Space toggles without moving it; BPM field keeps its Space. Unfocused click = INCONCLUSIVE (exit 2) |
| `played-edge-e2e.cjs` | `test_native_played_edge_ui.py` | `ui_played_edge.rs` | From rendered pixels: at 6 paused positions and 12 playing frames every informative lane column left of the playhead glow is played and every one right of it is unplayed |

## Open budgets (measured)
5 runs on the qualify build. All four steps held at the same poll, so they share one distribution: first open
median 319 ms / max 889 ms, second open median 243 / max 256, re-open median 240 / max 247. Budget = 2x the worst
value = **1800 ms** for every step. N13 (0.56 s) is a release, visible-display budget for Q-15 and is only printed.

## Mutation checks (all failed as required; mutation reverted, diff confirmed)
Temporary edits behind an env switch, one build:
- decode on open (helper `--measure-input` before open): "open decoded audio through the helper: [...vocals.flac]".
- wrong project (opening B opens A): hook times out, "Open 'second' did not reach every step within 25s".
- Re-detect drops `user_bars` (`flush_beat_detection`): "Re-detect dropped the bar from the popover".
- Space ignores the BPM field (`desktop_keyboard.rs`): "Space typed into the BPM field also toggled the song".
- Manual wizard starts the download: "a download was started without consent: curl ... gpu-splitter-darwin-arm64.tar.gz".
- Lane painter quantizes position to 0.25 s: "paused 3.46: 2 of 390 columns left of the playhead are NOT played; playing 11: 6 of 458".
- Saved channels ignored on read: "the saved channel choice was not restored" (outputs [0,1] vs [6,7]).

## Not covered / limits
- Played edge resolution is the playhead glow (26 device columns each side, about 13 points); the one-device-pixel
  floor/round difference between clip and line is not seen, and the quantization mutant is only just caught (lag
  inside the glow passes). While playing the painters take the playback clock, so references come from the paused view.
- The wizard's first-launch (Auto) origin is suppressed in hidden mode and downloads required models immediately
  behind a Skip button by design; the driver covers the manual origin. Whether Auto should wait for a click is a
  human decision (Electron's wizard text was not compared).
- Settings: synthetic inventory only; settings/training exclusive ownership across relaunch (R-02) not covered.
- Space: the driver requires a mouse click to focus Mute; the native app passes that leg.
- Qualify (release) builds open What's new automatically, so every driver seeds `release-highlights.json`.
- A current `key` analysis is seeded; without it every open runs key detection (decodes guitar/piano).
- Windows field laptop not run.

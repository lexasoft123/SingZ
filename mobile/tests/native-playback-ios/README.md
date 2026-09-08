# Native playback on the iOS simulator — log-driven driver (UNREVIEWED, untracked)

Written by the e2e-verifier on 2026-09-02 after two field bugs (a refused
graph rebuild on every song open, four identical rebuilds per pitch change)
shipped in ad-hoc builds 41-45 without any simulator run of the native
player. It seeds a long native-eligible project, captures the player's
backend by wrapping `createPlaybackBackend` through Metro's dev `__r`,
reads the app log the way the Log panel does, and asserts with numbers:

1. open = exactly one "preparing graph" / "graph ready", no "graph build
   refused", no "cue rebuild failed";
2. Play reaches "rendering started" without a new "preparing graph"
   (measured 73-79 ms on the sim);
3. one pitch change = one "cue graph rebuilt"; a repeat is skipped;
4. position advances continuously (no 200 ms stairs); a seek reads the
   target on the first sample after it resolves;
5. leaving the player unloads the native generation.

Env: SIM_DEVICE_NAME (exact Metro deviceName), REPO_MOBILE, STEMS_DIR.
**Simulator precondition: the Mac's default output must run at 48 kHz.**
At 44.1 kHz the simulator's RemoteIO finalizes MaximumFramesPerSlice
4459 (= 4096 × 48000/44100), above the prepared 4096, and the host refuses
the handoff ("RemoteIO finalized a callback size outside the prepared
bounds") — see docs/IOS-AUDIO.md. `rio-probe.mm` measures that bound;
`skip-check.cjs` exercises the unchanged-configuration skip and the
click-off-from-pre-roll rebuild directly.

Before this becomes a permanent harness: review it, make it probe/assert
the output rate itself, and list it in `.claude/agents/e2e-verifier.md`.

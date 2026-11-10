# D-07 — Does the GPUI helper move onto `AudioHostBackend`, and when?

Decision record, written 2026-11-10 against `codex/gpui-interface` at `f7607311`.
Paths are relative to the repository root; `$G` is `experiments/gpui-player`.
Anything marked *(inferred)* was not checked against code. Nothing was built or
run for this record; it rests on reading the tree.

## Question

`COMPLETION_PLAN.md` asks whether the playback helper `singz-gpui-audio` should be
moved onto the `NativePlaybackSession(std::unique_ptr<AudioHostBackend>)` seam
before the native desktop becomes default, after it, or never, and what late
movement would cost in qualification. C-80 (8 worker-days, `gpt-6.1-sol`) is the
package that would do it.

The code answers the first half: **the move has already happened.** The question
that is left is narrower: what small work closes the seam before default, and
whether the helper's line protocol should ever converge on the Box host contract.

## Inputs, and what was verified

| Claim | Evidence | Status |
|---|---|---|
| The helper builds a platform `AudioHostBackend`, hands it to `SharedAudioService`, and constructs `NativePlaybackSession` from `service->playbackBackend(...)` | `tools/native/singz-gpui-audio.cpp:685-691` | Verified. R-11's central claim holds |
| The `--devices` inventory path also goes through the session | `tools/native/singz-gpui-audio.cpp:652-655` | Verified |
| Platform backends come from zCore factories, behind a thin output-UID scoping decorator that is itself an `AudioHostBackend` | `tools/native/gpui_audio_provider.h:112-121` (factories), `126-175` (`GpuiOutputScopeBackend`) | Verified |
| The fixture path uses the zCore fake backend through the same seam | `tools/native/singz-gpui-audio.cpp:418-455`, `683-687` | Verified |
| The session constructor exists in this tree | `native/playback/native_playback_session.h:897-899`; interface at `third_party/zcore/zcore/include/zcore/device/audio_host.h:235-281` | Verified. This closes the last bullet of plan section 9.2 |
| Electron and Android compose the same way (shared service client wrapped around a platform backend, then a session) | `native/electron/playback_addon_bridge.cpp:1640`; `mobile/native/bindings/android/native_playback_jni.cpp:36`; `native/playback/shared_audio_service.cpp:628-642` | Verified. The only structural difference is that the helper owns its own `SharedAudioService` instance instead of the process singleton |
| The helper was on this seam before PR #145 arrived | `git log -S"service->playbackBackend" -- tools/native/singz-gpui-audio.cpp` → `7d6a5b9e`; the merge `b9ed894d` changed only one include line under `tools/native/` (`gpui_audio_provider.h`) | Verified. So the "depends on PR #145 merging" condition was never binding for the backend seam |
| The helper uses the session's generation fence and teardown-certainty results | `claimGeneration` at `singz-gpui-audio.cpp:948`; `abortPrepareDelivery` at `1283`; `TeardownUncertain` at `1359` | Verified |
| The CMake target links the shared session library | `CMakeLists.txt:490-498` | Verified |
| The helper does **not** report `starvedBlocks` | The session exposes it (`native/playback/native_playback_session.h:393`); the helper's lane status writes only `id`, `gain`, `muted`, `solo` (`singz-gpui-audio.cpp:923`); no occurrence of `starved` in the helper, and none in `$G/tests` | Verified. **N11 cannot be observed through the helper today** |
| The input helper is on the seam for monitoring, but with no provider choice | `tools/native/singz-gpui-input.cpp:90` constructs `AudioMonitorSession()`; its default constructor calls `createPlatformAudioHostBackend()` (`native/electron/audio_monitor_session.cpp:549`); on Windows that is always WASAPI (`third_party/zcore/zcore/platform/windows/audio_host_windows_provider.cpp:36-37`) | Verified |
| The input helper's analysis and recording path uses `AudioInput`, a separate zCore capture interface, not `AudioHostBackend` | `tools/native/singz-gpui-input.cpp:67`, `105`; stated as deliberate at `tools/native/gpui_audio_provider.h:2-4`, `123-125` | Verified. Electron's capture uses the same interface *(inferred from `shared_audio_service.h:7`, `27`)* |
| Box requires a native host to initialise the LoopZ routing owner first and use its driverless song backend | `docs/specs/singz-box/loopz-integration.md:149-162`; restated in `docs/rfc/0001-shared-product-core.md:433-444` | Verified as documented. The helper does neither, and the plan puts LoopZ on desktop out of scope (plan section 1) |
| The helper compiles and passes against the post-merge session | The only helper binary found, `$G/target/debug/singz-gpui-audio`, is dated 10:34 on 2026-11-10; the merge commit is dated 20:26 the same day | **Not verified.** No post-merge build evidence was found in this tree |
| CI builds the helpers | No `gpui` match in `.github/workflows/*.yml`; both helper targets are `EXCLUDE_FROM_ALL` (`CMakeLists.txt:491`, `504`) | Verified absent. An API change in the session can break the helper without any gate noticing |

R-11's command map and fencing table were spot-checked at the lines above and
not re-derived row by row.

## Options

Budget effects refer to plan section 3.1. Because the backend seam is already in
place, Q-01/Q-02 baselines already measure the session path; none of the options
changes N1-N5, N8, N10, N12-N14.

### A. Before default, as catalogued (C-80 at 8 days)

With the backend already injected, eight days could only be spent on converging
the helper's line protocol with the Box host contract, or on moving the helper
under the LoopZ routing owner.

- Cost: 8 worker-days on `gpt-6.1-sol`, plus a Sonnet review (V-01), plus a
  repeat of Q-03 on both machines. It also edits `singz-gpui-audio.cpp` and
  `$G/src/integration.rs` while the C-17 chain owns them.
- Risk: high. It rewrites transport command framing immediately before the
  timing qualification, for a product (GPUI on Box) the plan excludes.
- Budgets: no gain. N11, N6, N7 put at risk during the change.

### B. Close the seam before default; defer protocol convergence (recommended)

Replace C-80 with a small closeout package, C-80a, and record protocol
convergence as a separate, untriggered decision.

- Cost: 2 worker-days for C-80a (outline below). Optional C-80b, 2 days, if the
  human wants the monitor to follow the selected Windows provider. Saves 6 of
  the 8 days, or 4 with C-80b.
- Risk: low. C-80a adds a field to a status line and a CI build; no callback or
  transport code changes.
- Budgets: makes N11 measurable, which it is not today. No effect on the rest.

### C. Never; do nothing

- Cost: 0.
- Risk: the default gate lists N11 and Q-03 lists a `starvedBlocks` driver, and
  neither can pass against a helper that does not report the counter. The gap
  would surface in Q-03 as unplanned work on an escalated package. Helper
  breakage from session API changes stays invisible to CI.
- Budgets: N11 unverifiable.

### Protocol convergence, whenever it is done

Not an option for this plan, but the spec asks what late movement costs. If the
helper's protocol is later converged on the Box contract, or the helper is put
under the LoopZ routing owner:

- Estimate: 8-12 worker-days on `gpt-6.1-sol` *(inferred; no design exists)*.
- Requalification: Q-03 in full; every `$G/tests/test_native_*` driver that
  speaks to the helper; Q-10 and Q-11 on one commit with the Electron control
  beside the laptop run; the N6, N7, N9 and N11 cells of Q-15; and one beta
  cycle before it reaches the default channel, because playback timing is a
  default-gate criterion (plan section 6, item 4). Drive, migration, updater and
  accessibility qualification do not repeat, since the Rust side above the
  helper supervisor is untouched *(inferred from the D-01 boundary; D-01 is not
  written yet)*.
- What does not change if it moves late: the backend, the session, the callback
  and the DSP are the same objects before and after. Only command framing and
  process ownership move. That is why deferring is cheap.

## Recommendation

**Option B.** Treat "helper onto `AudioHostBackend`" as done. Shrink C-80 to
C-80a (2 days): report `starvedBlocks`, prove the post-merge build, and get the
helpers built and their session tests run in CI. Do it before default, after
C-18. Do not converge the helper protocol with the Box host contract inside
this plan; reopen that only if running GPUI on Box becomes a goal, and then
GPUI takes Box's contract, as the RFC already says.

## Consequences

- The plan's optional line drops from 1.5 engineer-weeks to 0.4 (0.8 with
  C-80b). Total becomes 29.4-41.4 instead of "30.5-42.5 with C-80".
- Plan text that is now stale and should be corrected by the coordinator:
  section 1's constraint row ("exists on the Box branch … When is decision
  D-07"); the C-80 row; the risk row "PR #145 does not merge in time"; the last
  bullet of section 9.2.
- Q-03's `starvedBlocks` driver depends on C-80a's status field. Either C-80a
  lands before Q-03 starts, or the field is folded into Q-03's edit list. The
  first is cleaner: Q-03 then only writes drivers.
- `singz-gpui-audio.cpp` is edited by C-18 and C-80a. They must not run at the
  same time; C-80a follows C-18, as the catalog already orders it.
- SingZ keeps two audio-control protocols (helper line protocol, Box host
  socket). This is accepted, not resolved. The shared part is everything below
  the protocol.
- GPUI on Box stays unsupported: the helper opens its own platform output and
  never initialises the routing owner.
- One thing for Q-02 to watch, not decided here: `SharedAudioService` keeps a
  silent base output open between clients (`native/playback/shared_audio_service.h:11-13`),
  and the helper only releases it on `park`. Whether a paused, unparked helper
  costs measurable idle CPU against N6 is unknown *(inferred risk; needs the
  Q-02 number)*.

## What the human must decide or sign off

1. Accept that C-80 as catalogued is withdrawn and replaced by C-80a, before
   default.
2. Accept two audio-control protocols for the life of this plan, with
   convergence deferred until GPUI on Box is wanted. If GPUI on Box is in fact
   wanted within the next two releases, say so now; that changes this record.
3. C-80b, yes or no: on Windows the monitor helper always opens WASAPI even when
   playback is on ASIO. Whether that pairing misbehaves on real ASIO hardware is
   not known *(inferred concern; needs one field-laptop or interface check)*.
   The current separation is documented as deliberate, so the default answer is
   no until a check shows a problem.
4. Windows field laptop time for C-80a's side-by-side run (rule 6), about half a
   session.

## Outline for C-80a — seam closeout (replaces C-80)

Tier: coder default, `--agent codex --model gpt-reserve`, effort medium. No
escalation: the change serialises a counter the session already maintains and
touches no callback, transport or ownership code. The coordinator's
code-reviewer gate applies as usual. Depends on C-18 (file ownership) and C-04
(CI job to extend). Size: 2 worker-days, including the two-machine run.

| File | Change |
|---|---|
| `tools/native/singz-gpui-audio.cpp` | In the lane status writer (line 923), add `streamed` and `starvedBlocks` per lane from the session status. No other change |
| `$G/src/` status parser and diagnostics (the module that parses helper status; owned by the C-17 chain until it finishes) | Parse the two fields; expose the per-lane maximum in diagnostics so a driver and a field report can read it |
| `$G/tests/test_native_audio.py` | Assert the fields are present and zero after a seek, a loop wrap and a restart on the fake backend |
| CI workflow added by C-04 | Build `singz-gpui-audio` and `singz-gpui-input` on all three platforms; run `native_playback_session_tests` and `shared_audio_service_tests` (`CMakeLists.txt:839-857`) in the same job |

Evidence that proves it:

- A clean helper build at the package's commit on the Mac and the Windows
  laptop, with the stale-binary check (rule 7): `strings` shows `starvedBlocks`
  in the new binary.
- `test_native_audio.py` green on both machines, and red against the previous
  helper binary (the negative control).
- A deliberate starvation control: a run where a lane's feeder is withheld
  shows a non-zero count, so the zero is known to be a real reading. If the
  helper has no hook to withhold a feeder, the worker stops and asks rather
  than adding one *(the hook's existence was not checked)*.
- CI job green, and red when the helper target is made to fail to compile.
- N11 itself is then measured by Q-03's driver and Q-15, not by this package.

## Outline for C-80b — monitor follows the selected provider (only if item 3 is yes)

Tier: escalated, `--agent codex --model gpt-6.1-sol`, effort medium, because it
changes which device owner the monitor opens (session ownership). Sonnet review
(V-01) before the gate. Size: 2 worker-days.

| File | Change |
|---|---|
| `tools/native/singz-gpui-input.cpp` | Accept `--provider`; in the monitor branch (line 90) build `AudioMonitorSession` from `createGpuiPlatformAudioProvider` instead of the default constructor. Leave the `AudioInput` analysis path alone |
| `tools/native/gpui_audio_provider.h` | Only if input UIDs must be scoped the same way as outputs; the header currently says they must not (lines 123-125), so prefer no change |
| `$G/src/` module that spawns the input helper | Pass the selected provider on Windows |
| `$G/tests/test_native_monitor.py`, `tools/native/test_gpui_audio_provider.py` | Provider is honoured; a mismatched provider and device is refused with a named error |

Evidence: both tests green on Mac and Windows; a monitor session on the field
laptop with the Electron control beside it; an ASIO run only if hardware is
available, otherwise reported as unverified.

## Not checked

- Whether the helper builds and its drivers pass at `f7607311`.
- Which Rust module parses helper status, and whether a feeder-withholding test
  hook exists.
- Whether WASAPI monitoring beside ASIO playback fails on real hardware.
- D-01's supervisor boundary, which is not written yet.

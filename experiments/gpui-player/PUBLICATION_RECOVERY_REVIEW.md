# Publication retry, Escape and notice ownership — 2026-11-08

The covered follow-up to [output recovery](OUTPUT_RECOVERY_REVIEW.md) is verified
on macOS and Linux VM403. The full desktop goal remains active. This is a native
interaction checkpoint, with no production visual parity or hardware recovery claim.

## Behavior

An actual Source Save publishes metadata, then the test quarantines those exact
bytes before the host reads them. The resulting real read failure retains the
working document, unsaved accepted mix, editor draft, rendered lyrics and hash-bound
publication receipt. Escape dismisses the notice without discarding the receipt.
A second Escape on Player and closing Settings with Escape also retain it.
Another Save cannot create a duplicate writer or overwrite the published bytes.
Unrepaired Retry retains the document; valid but different metadata is refused;
restoring the exact published bytes lets explicit Settings Retry adopt the saved
project and prepare paused audio. Actual native Play then advances.

A notice now takes root keyboard focus above an editor or Settings, consumes
underlying input, and restores the previous mounted nested focus on dismissal.
Real Space/Escape checks preserve the lyric draft and return to its text input.
Notices render above loading and Source progress, with platform window controls
retaining their own topmost layer. The notice Close target is measured and clicked
through app-local pointer dispatch while Save progress is held beneath it.

Header Save now visibly disables while loading, saving, recovering, or awaiting
publication adoption. Its click, Enter/Space and tab/focus admission are removed
while disabled; the model admission fence remains independently checked. The
controlled small ghost pill lives in sibling UIKit `gpui/src/controls.rs`, using
the source disabled opacity 0.45/default cursor and no hover. Existing enabled
factory behavior is preserved. Focus leaves Save before its handle is unmounted.

Escape closes transport popovers and Settings/Log/Training screens before the
Source busy guard. Only an active cancellable Source job can be cancelled there;
completed publication and active Save are retained. Save progress offers no Cancel
action. The active-Save test invokes the exact cancellation controller before the
next frame can consume the writer result; it does not claim full real-key routing
during an asynchronously active writer. The progress-overlap frame explicitly
holds renderer state, proving visual/control precedence rather than reproducing
the asynchronous TransportFailed/Save overlap timing.

## Final evidence

Final P7 normal Rust suites pass **781 tests, zero failures, two ignored on each
platform**. Mac and Linux UI builds pass; the normal Mac executable is restored.
No builds or native-heavy tests ran during the final hidden/muted captures.

| Workflow | Mac PNGs / apps | Linux PNGs / apps |
| --- | --- | --- |
| Publication fault, repair, Escape and notice focus | 29 / 3 | 29 / 3 |
| Source split, handoff, Save, conflict, rename, cancellation | 14 / 1 | 14 / 1 |
| Recovery, independent lyric Save, restart, offline adoption | 19 / 3 | 19 / 3 |
| Settings | 16 / 3 | 13 / 3 |
| Graph Save/restart | 8 / 2 | 8 / 2 |
| Empty project | 16 / 3 | 16 / 3 |
| Lyrics editor | 22 / 1 | not run in this Linux batch |
| Carry | 20 / 4 | not run in this Linux batch |
| Delete | 12 / 1 | 12 / 1 |
| Total | **156 / 21** | **111 / 16** |

Independent validation passes **267 decoded PNGs / 37 app launches**, all 21 frozen
app-source hashes plus the changed UIKit file, binary receipts, recovery state
sidecars, exact persisted metadata/lyrics/media hashes, paused native seek and
actual Play advancement. Foreground identities remain unchanged; Linux clients
remain unmapped on private Xvfb/Openbox displays. Independent PID/start checks
confirm retirement of 111 observed Mac and 72 Linux app/helper owners. All three
approved Kimi job identities are retired. Only the exact two task containers are
stopped; host PID1268/startTicks4023 still owns PCM0p in PREPARED, other containers
are unchanged, and source/caches remain. The user's preview is untouched.

Recovery frames use 1280×800 or 1060×640 at 2×. Fifteen legacy Mac Settings/Carry
frames remain 2560×1602 and are excluded from the 1280×800 contract. Images are
not rescaled, aligned or masked. Representative full Mac/Linux notices, disabled
Save, retained focused editor and repaired playback/visible lyrics were inspected.
There are no matched production references for this new fault state, and the
complete visual/control/temporal matrix remains unqualified. Font files and the
approved partial-glyph highlight/glow paint are unchanged.

CPU/memory samples are retained in workflow performance reports. For example,
the Mac publication working phase records 13 CPU samples, mean 69.45% of one core
and max 95.83%, during forced offscreen rendering; this is not idle playback cost.
Live display FPS and GPU utilization remain unmeasured. Linux uses software
rendering and exposes no hardware GPU to this runtime.

## Review, preserved failures and limits

After the user's explicit private-source sharing approval, actual Kimi K3.1 Fast
native CLI jobs reviewed Escape/focus and healthy publication lifecycle, and
implemented the Header Save state in the shared checkout with exclusive file
ownership. Root integrated the UIKit helper, admission/focus/layering changes,
tests, builds and captures. Reports, bounded prompts, logs and owner retirement
receipts are preserved. The earlier approval-review rejection is historical;
the explicit Yes resolves that source-sharing authorization.

The P2 negative reproduction confirms the old Escape bug: closing a notice lost
the pending receipt and left the notice present. P4's green 261-capture batch
predates the second-Escape, active-Save, layering and disabled-control fixes and
is retained as interim evidence. Initial harness compilation failures and P7's
test-helper borrow error are preserved; no recursion-limit increase was used.
P6's first Mac suite had two engine-probe startup timeouts. Its focused engine
suite and unchanged full rerun passed. P7 passes both default suites, without
deadline relaxation, production retries or weakened assertions. The recurring
engine startup issue is still unresolved.

The lifecycle review found that ordinary healthy, unmonitored Save already queues
Pause before Save/read on the same FIFO. No continued-audible-playback bug is
claimed. A failed read can retain an owned paused helper and telemetry; local UI
playing=false alone cannot prove native pause. A healthy-live-helper publication
fault with a pre-admission native status tap remains untested. Monitor/training
handoffs must be qualified before any change that retires that connection.
Settings popup-first/focus return and actual active-writer Escape dispatch also
remain outside the current connected proof. Recovery copy/localization, physical
hotplug/permissions, latest Windows, native choosers, live services/models,
accessibility, full production visual parity, live FPS and release packaging
remain open. No staging or commit was performed.

## Artifact identities

Artifact directory:
`/Users/maxplanck/.codex/visualizations/2026/11/05/01a1add5-9a90-73c3-bec3-c18bfb04e619/gpui-publication-recovery-20261108`.

`final-source-p7.json`, `uikit-overlay-p7.json`, `final-capture-manifest.json` and
`independent-final-validation.json` identify the final source/captures. The changed
UIKit file SHA-256 is
`f1a1b94b333daedbe0879d42552f88fb0fa9ec57f567254d57bed889c50e44e3`.
The retrieved Linux archive is `publication-recovery-p7-evidence.zip`, SHA-256
`615aed387a8954517c05f5a5e1b1a0b5017f4e5258c658b8785016aab0d7a19f`
(80,667,688 bytes), independently reopened, CRC-checked and extracted. Final
combined archive identity is recorded separately in the artifact receipt.

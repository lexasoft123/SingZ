# Native reply capability intake — 2026-11-08

First-lane admission into an empty project can open a newly selected default
output and return its capabilities on a raw transaction receipt. The previous
reader remembered inventory only in `Connection::open` and `Connection::command`,
so raw lane/rate/Carry replies could lose that snapshot. A captured receipt from
the real helper's explicit fake-host mode reproduces the first-lane case; the
regression fails against the former reader with “Raw native lane admission
discarded its device capabilities.”

Every connection reply now passes through the same capability intake. Successful
snapshots require valid native status and inventory. Cache mutation requires the
connection to remain the current, live owner, including a check while holding the
cache lock. Failed replies, malformed clocks, superseded owners and shutdown
cannot publish capabilities. Ordinary status/Pause gain no inventory query or
payload. The C++ helper and its protocol are unchanged in this checkpoint.

Copy can drain an already-issued reply from the old epoch and retain that same
helper. Rejecting its cache mutation outright would discard the only snapshot:
the helper publishes another automatically only when the actual output changes.
The connection therefore retains the unadmitted facts locally. A successful,
valid status from the new owner must confirm the same output UID before promoting
them once. A new helper has a separate pending slot; a different actual output
drops the pending facts. No old graph, transport or document authority is adopted.

Promoted older inventory cannot prune newer endpoints, overwrite known positive
channel counts or replace a known unsupported direction. It can fill explicitly
busy unknown counts and add missing proven capabilities. The cache remains
bounded at 1,024 endpoints. Normal fresh inventory still evicts removed endpoints;
UIDs remain opaque and native admission still decides whether a route opens.

The final Rust suites pass **775 tests, zero failures, two ignored on both Mac
and Linux**. New cases cover raw receipt intake, refused/malformed/revoked owners,
retained Copy promotion, different-helper/output refusal and preservation of newer
cache facts. The stored first-lane JSON comes from real native decode/DSP using
the private fake provider; it is not physical default-device or hotplug evidence.

An intermediate Linux run exposed `ETXTBSY` in a test that wrote, executed and
rewrote its own shell fixture while other tests spawned children. The fixture is
now an immutable repository script with executable mode 0755 and separate input
paths. Cancellation requires the child-ready marker and the cancellation error;
oversized output requires the actual bound error. Existing deadlines and output
bounds are unchanged, with no production retry added. An inherited writable-file
descriptor reproduces the kernel error independently; the exact parallel child
from the failed suite was not traced.

The first final Linux deployment stopped before Cargo because its source-manifest
transfer failed. A six-file ZIP was then checked by archive hash and member hashes
before applying it. A subsequent unit launch incorrectly inherited the UI-only
`SINGZ_NO_SYNC=1`: 13 Drive tests failed because their synchronization was disabled.
That terminal run is retained. Correcting the test environment gives the final
775-pass suite without source changes or relaxed assertions. The previously
recorded intermittent engine-probe timeout remains unresolved.

Final hidden, muted interaction checks pass **99 PNGs across 18 app launches**:

| Workflow | Mac PNGs / apps | Linux PNGs / apps |
| --- | --- | --- |
| Empty Remove/Save, Copy/Move, restart and paused re-add | 16 / 3 | 16 / 3 |
| Library Copy/Move, conflicts, retained playback and imported Save | 11 / 1 | 11 / 1 |
| Active-output Settings, restart and missing saved route | 16 / 3 | 13 / 3 |
| Saved graph playback, Save and restart | 8 / 2 | 8 / 2 |

An independent archive check verifies all image decodes and recorded hashes,
viewport/scale records, the six source pins and executable fixture mode, four
binary pins per platform, exact app counts, nonempty canonical Mac process
identities, unchanged foreground samples, unmapped Linux windows and retirement
of every observed native identity. Representative full images were inspected.
Linux records workflow CPU/RSS under software rendering, including readbacks;
GPU usage and live display FPS remain unmeasured. Legacy Mac Settings captures
are 2560×1602 without viewport sidecars. These are workflow checks, not matched
production visual/temporal parity or shown Linux-frame qualification.

The earlier 773-test/77-PNG candidate is preserved separately and does not qualify
the final deferred-Copy implementation. Final evidence is in
`gpui-reply-inventory-20261108` in the chat visualization directory, including
`verified-workflows.json`, `verify-checkpoint.py`, failed attempts and frozen
source copies. The final remote ZIP SHA-256 is
`432a378ff42915e6870c7127334b84eb9a48faff78c4b91d2009b5e25339fa31`.
The final Mac UI app SHA-256 is
`30095bd4d5a5d5effc3f94f8a6bcac8883d85327a5b0384d6c2ab74f69c38395`;
Linux is `553ff4ea2a761ca5ecffab38ba5f271e5580a3e89da3effcd9106b4337a76c93`.
The native helper hashes remain those of the default-route checkpoint.

The normal Mac binary was restored after freezing the isolated UI bundle. Both
exact task-created Linux containers are stopped with source/caches retained;
all five builder supervisors and both UI supervisors are retired. Other container
states and the foreign PCM0 playback owner PID 1268/start identity remain unchanged.
No Node/Electron execution, activation/global input, staging, commit or user-preview
replacement was used. UIKit, fonts and approved lyric paint were not modified.

Next device work remains document retention and safe retry after a runtime output
failure. The current generic error path clears the project; ordinary Open also
resets editor/dirty state, so reusing Open is insufficient. Recovery must preserve
working edits, validate media/owner identity, reopen the requested route, restore
accepted mix/position paused, and save the route only after native acceptance.
Offline working-copy Save/publication also needs explicit adoption coverage.
Physical hotplug/microphones/choosers, live services/model releases, remaining
Windows deltas, Linux emoji fallback, Wayland/hardware GPU, accessibility, packaging
and production visual/temporal parity remain open. The full desktop goal stays active.

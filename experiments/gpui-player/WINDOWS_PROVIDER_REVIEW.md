# Windows provider draft checkpoint — 2026-11-09

Settings exposes native provider availability, persists explicit WASAPI/ASIO
intent and refuses unsupported or unavailable selections without fallback.
Unknown saved values appear unavailable. Playback output identities are scoped
by provider; independent input and monitor devices retain raw WASAPI identities.
Existing macOS provider defaults remain unchanged.

Changes require an unloaded renderer and no pending, active or retiring audio
owner. Generation/epoch checks reject stale requests. Durable preference I/O
runs outside the UI gate under a reservation; invalidated commits roll back
exact prior bytes, and failed rollback quarantines owner admission. Fresh device
inventory precedes the accepted provider acknowledgement.

## Native receipt repair

The Dell run exposed a real load failure: Rust reduced a native reply to just
`deviceInventory`, then required the discarded provider identity on that wrapper.
The reduced receipt now retains the actual outer provider/backend/fixture fields.
Current replies are checked before staging or promoting retained facts; copy
handoffs still transfer inventory facts only. Missing/foreign provenance and
stale owners remain rejected. Startup source/argument failures in the helper now
also retain provider attribution instead of masking their underlying error.

The Windows adapter additionally distinguishes same-choice acknowledgement from
a new provider commit, verifies the actual refusal reason and compares native
helper PID/status before and after negative controls. These are test adapters,
not assignments to renderer, owner or provider state.

## Evidence and limits

Evidence root: `/tmp/singz-windows-provider-20261109`.

- `mac-boundary-v1`: updated native helper build and provider CLI pass, including
  invalid-source/argument error provenance. The unchanged full Rust retry passes
  922 tests, zero failures and two installed-model ignores. Its preceding run
  passed 921 and hit the historical two-second engine-probe fixture timeout;
  `unit-tests.log` preserves it. The timeout cause remains unresolved. No deadline
  or assertion was relaxed.
- Updated normal/UI macOS builds pass. UI SHA-256:
  `e84facfefd7d21016704189b7ba8e24ef23a828785433614fd9d1493636bd6f6`;
  normal: `a5b274fbcffbc333f3860e4a94a876da5dcc12f46e104e9a601d20b2ecb4d738`;
  helper: `829594dbc82098caba2b6d3896771b2e16a4aedf86b2d4c091838aa6363fd44b`.
- `mac-boundary-v1/graph-ui`: real native graph Open/Play/output/Save/restart
  passes across two launches and 12 captures, including output popups at both
  content sizes. Foreground remains unchanged, all 21 observed process identities
  retire without forced cleanup, and 27 app CPU/footprint/system-GPU samples have
  no errors. Helper CPU and live FPS are not measured by this observer.
- Dell `provider3`: native helper/CLI and optimized normal/UI builds pass. Its
  Rust suite exposed four raw-Linux-fixture/Windows-route assertions; a test-only
  correction plus explicit Windows raw-output refusal coverage passes 863 tests,
  zero failures and two ignores under `provider4`. This precedes the receipt
  repair above and is not final-source Windows qualification.
- Dell `provider-ui1` fails the unchanged focus guard on a short-lived PowerShell
  foreground window whose parent could not be recovered. `provider-ui2` keeps
  focus unchanged, verifies initial selector actions, then fails Open on the
  discarded-identity bug. Both failed batches are retained. Four direct native
  replays of its exact WAV succeed (real/fake backend, ordinary/extended path),
  isolating the Rust boundary rather than a decoder or file-path failure.

- Dell `provider5` builds the repaired published source (`14715b4e`) and passes
  865 Rust tests, zero failures and two ignores. UI binary SHA-256:
  `d4680362dbfa004a92eedeea7dd35b8c4c3e29b2068ea6d6067090420876f25d`.
- `windows-ui3-result.json`, `windows-ui3-runner.json` and
  `windows-ui3-workflow.json` report the actual Windows hidden provider/restart
  journey passed across two app launches. Foreground remains unchanged; recorded
  frame observations have equal outer/client sizes and all eight resize hit tests
  pass. This is scoped interaction/frame evidence, not matched visual parity.

The repaired source's scoped Dell provider gate is passed.
Windows candidates use an inert public HTTPS configuration and explicit basic-only
codecs; real Drive consent and the full codec package remain unqualified. ASIO's
licensed adapter remains unimplemented and disabled. Physical microphone/output
audibility, complete visual/temporal parity, accessibility, packaged delivery and
live FPS remain open. Reviewed screenshots are native candidates, not matched
production reference pairs. No Node/Electron runtime, real credential export or
OS/global input automation was used. Temporary caches, snapshots, binaries and
capture archives are excluded from commits.

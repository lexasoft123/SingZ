# Windows provider draft checkpoint — 2026-11-09

Settings now exposes the native helper's provider availability, persists explicit
WASAPI/ASIO intent and refuses unsupported or unavailable selections without
fallback. Unknown saved values appear unavailable. Playback output identities
are provider-scoped; independent input and monitor devices retain raw WASAPI
identities. Existing macOS provider defaults remain unchanged.

Provider changes require an unloaded renderer and no pending, active or retiring
audio owner. Generation and epoch checks reject stale requests. Preference I/O
runs outside the UI-acquired gate under a reservation; invalidated commits roll
back exact prior bytes, and failed rollback quarantines further owner admission.
Fresh device inventory precedes the accepted provider acknowledgement.

Validation recorded in `/tmp/singz-windows-provider-20261109`:

- `full-tests-v3.log`: 920 Rust tests passed, zero failed, two installed-model
  tests ignored. Includes inventory roles, stale generations, slow preference
  writes, rollback and quarantine. An earlier harness incorrectly disabled sync;
  its 16 Drive failures are preserved separately in `full-tests-v1.log`.
- Native macOS helper build and provider CLI checks pass. Normal and UI-feature
  macOS builds pass (`mac-builds.json`). These builds precede the final small
  unavailable-label correction; they do not establish final Windows UI behavior.
- Added a Windows-only hidden two-process provider/restart driver and registered
  it with the existing resource/focus observer. It has not yet been run on Dell.

This is source integration, not Windows qualification or visual parity. ASIO's
licensed adapter remains unimplemented and disabled. Actual WASAPI playback,
disabled-state interactions, restart, process retirement and resource evidence
still require the Dell run. No new UI screenshots or live FPS claims are made.
No Node/Electron runtime was used. Temporary source snapshots, credentials,
compiled binaries and evidence directories are excluded from this commit.

# Native Drive platform qualification

## Current state — 2026-11-09

The maintained Windows and Linux observers now accept `drive-retirement` and
`drive-empty`. These are qualification adapters, **not platform passes**. The
current lifecycle app source is the local checkpoint `a1dd47e5`; the observer
changes have not yet been executed on either target platform.

The Dell and VM403 were reached over SSH and their expected machine identities
were confirmed. No GPUI/compiler process was found running in those inventories.
VM403's dedicated native container was stopped. Its existing Linux codec pack
manifest identifies `linux-x64`. Dell's permanent user Rust installation reports
Cargo 1.99.1; the expected default Windows codec manifest was absent. Other codec
locations and actual runtime capabilities remain unqualified.

Automatic approval review rejected uploading the private source archive to
VM403. No source archive was transferred and no remote build or UI workflow was
started. Explicit approval to copy the proprietary source snapshot to the two
test machines is pending. The prepared snapshot excludes production OAuth
configuration and substitutes an inert public fixture; its credentials cannot
authenticate to Google.

## Required matrix

| Case | Native app runs | Viewports | Required lifecycle |
| --- | --- | --- | --- |
| `drive-retirement` | 2 | 1280×800, 1060×640 | Delete last project, reuse its name, typed Rename, reuse that name; exact remote lineage proof |
| `drive-empty` | 6 | 1280×800, 1060×640 | Native writer, fresh online reader, offline reopen at each size; publication and recovery receipts |

The observers run each maintained driver's complete default matrix. A
compact-only retry does not replace the required two-size platform result.

Both observers retain independent hidden-window, foreground, process identity,
natural retirement and resource observations. Windows also retains its frameless
geometry and eight resize-edge checks. Every nested Drive run must have its own
observed app identity, window and CPU/RSS sample. Any observed native input helper
fails these non-microphone workflows. Linux keys windows by PID, process start
ticks and window ID because sequential clients can reuse X window IDs.

## Commands after source and toolchain qualification

Run the full pinned-codec native helper build and locked Rust tests/UI build
before either workflow. Preserve the runtime binaries and all source hashes
through the capture batch. Use fresh output directories and isolated test data.

Linux, inside the existing private-display test environment:

```sh
python3 experiments/gpui-player/tests/run_linux_ui.py \
  /isolated/runtime/singz-gpui-player /isolated/evidence/drive-retirement \
  --case drive-retirement --timeout 660
python3 experiments/gpui-player/tests/run_linux_ui.py \
  /isolated/runtime/singz-gpui-player /isolated/evidence/drive-empty \
  --case drive-empty --timeout 1500
```

Windows, through the established hidden interactive-session launcher:

```powershell
& .\experiments\gpui-player\tests\run_windows_ui.ps1 `
  -Python $IsolatedPython -App $IsolatedApp -Out $FreshRetirementEvidence `
  -Case drive-retirement
& .\experiments\gpui-player\tests\run_windows_ui.ps1 `
  -Python $IsolatedPython -App $IsolatedApp -Out $FreshEmptyEvidence `
  -Case drive-empty
```

New Windows workflow deadlines are 660 and 1500 seconds, accounting for two
300-second or six 240-second app budgets plus fixture shutdown. Existing Windows
cases retain their 300-second observer deadline. Linux's explicit timeout above
avoids truncating the six-run workflow with its general 900-second default.

## Local validator evidence

`test_linux_drive_observer.py` executes the actual Linux validator in isolation,
without importing the runner's X-server entry point. Twelve tests pass, including
adversarial missing observations, recycled PID identities, a missing sample for
one of six runs, forced termination, unexpected input helper, partial matrices,
wrong binary identity, wrong capture dimensions and a sync-enabled reader.

```sh
PYTHONDONTWRITEBYTECODE=1 python3 \
  experiments/gpui-player/tests/test_linux_drive_observer.py -v
```

These synthetic receipt tests do not establish PowerShell syntax compatibility,
actual Linux process/window observation, target builds, codec capability,
physical-device behavior, Google consent, visual parity or live display FPS.
Target qualification remains open until the actual workflows produce and pass
their platform observations and their full screenshots are inspected.

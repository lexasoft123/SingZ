# Native Drive platform qualification

## Current state — 2026-11-09

The maintained Windows and Linux observers now accept `drive-retirement` and
`drive-empty`. These are qualification adapters, **not platform passes**. The
lifecycle app has later local checkpoints through `165781d0`; the observer
changes have not yet been executed on either target platform.

The Dell and VM403 were reached over SSH and their expected machine identities
were confirmed. No GPUI/compiler process was found running in those inventories.
VM403's dedicated native container was stopped. Its existing Linux codec pack
manifest identifies `linux-x64`. Dell's permanent user Rust installation reports
Cargo 1.99.1; the expected default Windows codec manifest was absent. Other codec
locations and actual runtime capabilities remain unqualified.

The initial automatic approval review rejected the archive as private/proprietary;
no transfer or remote build occurred at that point. A later authoritative audit
corrected that premise: both GitHub repositories are public, and all 2,152 source
files in the prepared archive exactly match blobs in published app `165781d0` and
UIKit `e9989977` commits. The remaining payload file is an inert OAuth fixture;
all 2,154 ZIP entries were scanned against actual production OAuth values with
zero matches. Embedded metadata contains only the exact file size/hash inventory.

Automatic re-review accepted the same direct transfer with this new evidence.
VM403 now holds `source-165781d0-v4-public.zip` at
`/home/singz/dev/gpui-native-20261108/`; its remote SHA-256 is
`f6aafe7c0245e8619f5d978dd7e5e18f5a9ac368dd7edd288c49ae26750d013f`
and its size is 19,631,104 bytes. This resolves the transfer blocker for that
**published public snapshot**. No current uncommitted UI work, production OAuth
configuration, account tokens or compiled app was included. A fresh source
snapshot must be audited after the current checkpoint is published. Transfer
alone is not a remote build, codec or UI workflow pass; those gates remain open.

## Current public-checkpoint follow-up

Published app `711ac271` and UIKit `6f694bf` were transferred to both VM403 and
Dell as `source-711ac271-public.zip`: SHA-256
`d358d03bf1ae4ffa08af00f530b193289bf503e7674f2885afc3715ee24ba2bd`,
19,661,559 bytes. All 2,158 source files match exact published Git blobs; an
inert OAuth override and inventory complete the archive. All 2,160 entries were
scanned with zero production credential matches. Both targets verified the ZIP
hash; Dell also verified every payload hash. No private working source was sent.

VM403's native helpers build with the pinned full-codec SDK and its UI-enabled
Rust check pass. The first full Rust suite is **rejected**: 1,011 passed, two
failed, two installed-model tests ignored. The pipeline stopped before app builds
or UI journeys. These are not new platform workflow passes.

One failure was transport metadata: the ZIP preserved bytes but discarded Git's
executable modes. The committed `tests/shared/native-measure-fixture.sh` is
`100755`, while the ZIP stored `0600`; the test correctly rejected it before
spawn. Authoritative modes were restored only after the build was confirmed
terminal, all 2,158 Git blobs and every payload byte were reverified, and the
**unchanged** custom-track validation test then passed on VM403. This repairs
source delivery rather than weakening the executable-mode assertion.

The mode-aware archive/export check now records Git modes in the inventory and
ZIP attributes; extraction verifies bytes, hashes, safe ordinary paths and exact
permissions. Its published-711ac271 archive SHA-256 is
`d721953e6cf2970cb84eac9d27700fe872f0b93a0620336b656c6cf3419c2a16`.
A fresh local extraction verifies all 2,159 payload files and 20 executables,
including the stable helper at `0755`. Future snapshots must preserve and verify
modes as well as bytes; ordinary Python ZIP extraction alone is insufficient.

The other failure occurred before a probe started: the freshly written test
script returned `ETXTBSY`, so discovery completed before its fixed 80 ms
cancellation. The cancellation fixture now invokes stable `/bin/sh`, waits for
actual parent/child startup evidence in their owned process group, then cancels
and verifies both stopped. It retains the 40-second probe timeout and original
less-than-three-second total assertion. This is a test-only correction; it does
not change production spawning, fallback or deadlines and does not close the
separate historical two-second probe-timeout gate.


Local validation of the strengthened probe test passed, and the normal executable
remains byte-identical to the reviewed UI checkpoint (SHA-256
`726a7e3df4f2f47f765169c20f1e44c2687a3aae0be754a1a16bf9339fe7b499`).
The full local suite is also **rejected**: 1,012 passed, one separate Drive
upload-followup test timed out, two installed-model tests ignored. Its final
snapshot is busy at `Uploading project.json`; that alone does not distinguish
initial upload from continuation because login performs an earlier sync.
The request ledger/gate state was lost during fixture cleanup, so the cause is
unproven. A bounded external observer is being prepared to retain `/state` during
an unchanged test invocation; no production or test deadline has been relaxed.
This failed suite is retained rather than summarized as a successful checkpoint.

The canonical 12-file committed codec corpus and a reviewed Python/C++ harness
are ready for actual decoder qualification after successful builds. They are
not decoder passes yet. Full Drive journeys, shown native frame, real Google,
physical hardware, production parity and live FPS remain unqualified.

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

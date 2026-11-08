# Native desktop app on the Dell — 2026-11-08

This is the initial qualification history. The later
[Windows filesystem checkpoint](WINDOWS_FILESYSTEM_REVIEW.md) resolves the 41
Windows suite failures and qualifies a fresh combined graph/Drive/adoption batch
on app bd3fa144. Historical failures and d934 screenshots below remain historical.


Prior verified scope: graph open/analysis/playback/Save/restart, Drive writer
and account restart, and streamed adoption → actual catalog/player/mixer/lyrics/
Save → offline reopen pass as **three separate cases** on app
`d934b3e25f4f8f41b65cb45e418e98121cafe7e28c340ce7753807a39765a945`.
There are 52 successful native PNGs across six app processes. The graph case
passes inside runtime7, whose host later fails the independent Drive path check;
runtime9 supersedes that Drive result and runtime11 separately passes adoption.
All three case guards retain focus and verify equal outer/client bounds with
eight resize hit codes. Resource samples include app/helper CPU and RSS plus
per-app GPU-engine counters. Live display FPS and production parity are unmeasured.
See archived verified-workflows.json and resource-summary.json for exact scope.

At this historical checkpoint the full Windows Rust suite was not green: 671 passed, 41 failed, two ignored.
Failures include Windows-invalid absolute path fixtures, path normalization
assumptions, directory moves with held child leases, concurrent replacement
checks, and training WAV lock interactions. An isolated Dell Rust probe confirms
that a directory move with a locked child returns error5, while ordinary replace
with an open reader succeeds and reads through the original/duplicated locked
handle succeed. Do not weaken locking or drop coordination on that evidence
alone: safe Windows move/publication and fresh-handle WAV validation still need
fixes and regression coverage. The failed suite is archived, not excluded.


This checkpoint qualifies the current Rust/native integration separately from the
2026-11-06 fixture-only Windows prototype. The verification copy is isolated at
`C:\Users\123\singz-lab\gpui-native-20261108`; the earlier prototype and user
libraries are preserved. The permanent user Rust 1.99.1 MSVC toolchain is reused.
No Node/Electron is executed by this workflow.

The new `scripts/build-gpui-audio.ps1` builds the audio bridge, analyzer and input
bridge with Visual Studio 2022, uses an exclusive per-copy native build lock,
limits compiler parallelism and stages the required pitch/training assets beside
the app. All three native targets build successfully. The Rust UI-feature app
also builds. The initial isolated-source bundle missed `align-mms.ts`, which
supplies an embedded Python runner; the export now follows literal Rust include
paths. The missing-asset compiler failure is retained, not treated as an app fix.

The actual native DSP graph check passes on the fake output host, including the
stored trim's measured output difference, tempo/transpose rebuilding, seek/loop,
park/unpark and malformed/semantic refusals. This test cannot emit hardware audio.
It belongs to the helper identity recorded in the build/runtime receipts.

The first hidden graph UI attempt stopped on an observed foreground change.
The native pitch-analysis launcher lacked `CREATE_NO_WINDOW`, unlike playback
and inventory. It now sets that flag on Windows. The interaction hook also
explicitly resizes and awaits its exact 1280×800 viewport before input; the initial
Windows window had been fitted to the display work area. Captures now include
viewport/scale/hidden/native-graph metadata, and the graph workflow requires actual
pitch analysis and saved detector results before proceeding. The shared normal
Rust suite after the launch fix passes 765 tests, zero failures, two ignored.

`tests/run_windows_ui.ps1` runs only in the logged-in user session. It checks
native windows without activation or global input, samples foreground handles,
records unexpected foreground process identity, measures outer/client rectangles
in one Win32 snapshot and tests all eight resize edges with read-only app-scoped
messages. CPU/RSS is separated between UI and native helpers; GPU-engine counters
run independently so slow WMI queries cannot block the focus/window sampler.
Failures retire only processes belonging to this verification copy, guarded by
process identity. Previous output directories are never overwritten.

Final Windows UI results are recorded in the evidence manifest; a compiler pass,
queued task or native-only DSP pass must not be read as a UI workflow pass.
Captures are background native candidates. There is no matching production
Windows reference, and live presentation FPS remains unmeasured. Full visual,
locale/accessibility, physical device/hotplug, real model/service, packaging and
remaining scenario qualification remain open under the full desktop goal.

## Console-free runner and publication fixes

The third run uses a compiled GUI-subsystem host with no window; it starts
PowerShell with CreateNoWindow, which launches the Python driver the same way.
The host and all workflow samples retain the same foreground HWND. This corrects
the test harness: PowerShell's -WindowStyle Hidden can create a console before
hiding it. The third run also confirms the resize-probe race: bounds changed
from 2400×1253 to 2560×1600 physical pixels between hit queries. The stable
1280×800 logical viewport at scale 2 has identical outer/client rectangles and
all eight exact resize hit codes pass. Transient bounds are recorded, never
compared against stale query coordinates.

The run then reaches native analysis and finds an actual Save failure, Win32
error 5. A direct Dell FlushFileBuffers probe reproduces error 5 with a read-only
handle and succeeds with a writable handle. Publication opened completed staged
files read-only before sync_all. It now opens them writable without create or
truncate, preserving the required durability check. The same pattern is corrected
in verified Drive download staging, model-download staging and native stem-export
staging. Existing project rollback/publication tests pass (10); the complete shared
Rust suite passes 765 tests, zero failures, two ignored with required loopback and
process permissions. A sandbox-only attempt is retained separately (713 pass,
52 fail from denied loopback/process access) and is not a product qualification.
Windows Save and Drive UI results after these changes remain pending until their
own terminal receipts have passed; the third run remains a failed Save run.

The fifth run qualifies actual Windows saved-graph playback, native pitch analysis,
Save and restart: both app processes pass, all eight PNGs and their scale/viewport
metadata pass, source graph/audio/foreign metadata remain intact, no owned process
survives, and foreground identity stays unchanged. The app hash is
`746d2e0c6bf3e043fe3ea3903dce748bd3cc1aa7b2d25f2b8584d3e31ef54189`;
the unchanged native helper hash is
`36fc045d9404d9ddd9463f547b9cc6dd619b53092da762aecb34d8b8ba46ab76`.

The same run's Drive branch fails an identity assertion before OAuth: the native
project is successfully loaded with a Windows canonical verbatim path, whereas
the test compares it against the uncanonicalized environment path. The Drive
hooks now canonicalize the existing project and the adoption destination's
existing parent before comparison; the destination itself must remain absent
until verified adoption. This is a test-only path fix. Its rebuild and the next
Drive run remain pending. The fifth run is a graph pass and a Drive failure,
not an overall Windows UI pass.

The sixth run repeats the graph pass on app
`9fe43313680bb8ee0d80cf626f94b603ac3baef4b59d5bdc1f69fcf591b2ba37`.
Drive now passes the project-load identity condition, then exposes another
platform-specific harness defect: fixed Mac coordinate (203,26) selects Vocal
training on the Windows header. The hook now clicks the actual measured Songs
anchor and checks that it is in the viewport. Both Drive hooks propagate a
missing-anchor failure. The Mac UI-feature cargo check passes; the Windows
navigation-hook rebuild is still running. Drive qualification is still open.

Current Mac UI and normal builds pass; the normal binary is restored at hash
`f438e7d02bd441a66b8496aeeca26da581e46c4044fbfc8141b197efacfb2cf2`.
All 86 bundled font hashes and 28 shared UIKit source hashes remain identical
to the preceding graph checkpoint. The user preview app was not replaced.

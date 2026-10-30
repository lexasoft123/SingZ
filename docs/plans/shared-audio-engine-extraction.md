# Shared audio engine extraction

Astra planning: `astra_extraction_plan` and `astra_integration_plan`, 2026-10-30.

## Outcome and invariants

Create an independent AudioZ source project, consumed through checked-in,
SHA-256-verified source snapshots and exact Git revisions. Builds remain offline
and do not discover sibling checkouts. Keep public C++ types, target aliases,
compiler policies, callback ownership and audio behavior unchanged during the
migration. Preserve SingZ behavior and explicitly validate LoopZ's upgrade to the latest shared code.

User steering: upgrade LoopZ to latest shared code, with both consumers on one
shared pin. SingZ starts at ac620fb0; LoopZ formerly used SingZ 3a7ab255 with
containment and planar overlays. Current SingZ publishes pre-limit limiter
peak/RMS; adapt LoopZ integration to preserve it. Retain the original generated
SHA-256 values only as before-upgrade evidence, not required final output: 91a1ca4bcc7c8fbaeac5cec11bcc5a65675bdeab12974fcd790c5ee93f55cfae
and b32d465b277ad4544856373510456143f5f9e5d1e39cd0b6573a06b28b5ab7ea.

## Boundary

AudioZ owns portable zcore base/audio/device/media, resample and live analysis
compatibility, zdsp graph/runtime/analysis/control, necessary codec source inputs,
realtime policy checks, reusable tests and benchmarks. Retain SingZ detectors,
ML/split code, product playback/session composition and product tests locally.
LoopZ retains routing/application policy, drivers, installers and platform capture
composition. Keep existing SingZ:: target names as compatibility aliases.

## Implementation sequence

1. Record sources and validation baselines; snapshot dirty LoopZ without touching
   its active checkout. Plan in Astra before assigning implementation.
2. Build standalone AudioZ with optional components; preserve original DSP source
   bytes. Establish one latest shared extraction revision with source provenance. Support verified, explicit imports from a local clone/full revision.
3. Switch SingZ CMake, desktop provenance, mobile manifests and generated pod
   mirrors to the pinned dependency. Separate retained legacy/ML targets locally.
4. Switch isolated LoopZ integration checkout to AudioZ; adapt overlays for latest limiter telemetry, validate the upgrade, and retain
   all unrelated existing edits. Never overwrite a changed live
   file from the initial snapshot.
5. Validate extraction independently, then upstream containment and idle-gain
   optimizations as a separate package revision. Preserve meter behavior and
   automation/ramp state; defer resampler replacement and limiter traversal changes.
6. Review the final source and pin relationships with Astra, fix findings, and
   report automated versus device/platform validation separately.

## Agent ownership

- Cheap foundation worker: independent AudioZ project, extraction manifest,
  standalone component build, tests and dependency import tools.
- Cheap SingZ worker: desktop/root CMake, retained local code, source provenance,
  dependency pin and desktop/build/source-contract tests (excluding mobile/).
- Cheap mobile worker: mobile source-root resolution, source mirrors, pod and
  Android integration checks; no changes to root package/source files.
- Cheap LoopZ worker: isolated LoopZ snapshot dependency paths, lock and verifier,
  overlay test paths, narrow integration checks. Starts after a slot is free.
- Coordinator: integration, snapshots/pins, validation, optimization phase,
  source-byte evidence and Astra review coordination.

## Required evidence

Standalone package configure/build/test without either application as a sibling;
complete pin inventory and tamper rejection; exact extraction source-byte checks;
SingZ native/graph/device/analysis and RT policy checks; regenerated iOS mirror and
component-ownership checks; Android native checks where tools are available;
LoopZ portable tests and unchanged generated overlay hashes; dependency-aware
native provenance hashes. Optimization evidence must compare outputs, invalid
sample counts, automation/state and relevant telemetry, plus matching benchmarks.
No installed or hardware acceptance is implied by offline tests.

## Delivery

Keep an independently inspectable AudioZ repository and focused consumer changes.
Do not release applications, install drivers, change audio devices or overwrite
unrelated work. Commit only reviewed trees; publish no unrelated product release.

## Scope update

User requested upgrading LoopZ to latest code. Supersedes the two-pin baseline
proposal above: use one shared current revision, adapting/removing overlays as
the shared implementations become authoritative. Keep extraction and optimization
validation separate; explicitly report the intentional LoopZ telemetry upgrade.

## Extraction baseline evidence

Astra approved staged AudioZ tree `c9d8ac3f16a0c2d2aba21df809ab3e1f272ed17d`;
commit `367504ce94b16914477143a36d5593781060cc3f` preserves all 237 extracted
source paths byte-for-byte. Standalone 4/4 tests pass; LoopZ upgraded baseline
portable 64/64 pass. SingZ baseline native 57/58 pass, with the remaining Apple
smoke requiring relocation of its shared link fixture into AudioZ. Original
iOS generated source mirrors match byte-for-byte (164/34/22/27 files in the
four components). Source/provenance checks: 104 passed, one skipped.

Astra baseline review identified and corrected platform source compile flags,
realtime scanner target coverage, canonical source overrides and pinned-import
semantics before the first commit. Product sanitizer gates stay in SingZ.

## Shared optimization revision

Astra approved staged AudioZ tree `b4c1b2c66582c50c57ab52fc3246e370dbb06ddd`;
commit `aae2cae17fc810dedcd911c4360b2221518ca5e3` is the shared final engine pin.
It adds exact containment batching/SSE2 and idle-gain processing, retaining
the current limiter and its input metering. Both consumers select canonical
verified sources even when a prior CMake cache contains overlay paths. LoopZ
source overlays and duplicate shared tests are removed in favor of package tests.

Standalone optimized Release: seven CTest suites pass, including the importer
negative tests and exact output/diagnostic comparisons. Both Apple smoke targets
compile for device and simulator architectures. The engine also builds for
Android arm64/API28 with real Oboe headers and library metadata. SingZ desktop
regressions: 129 files, 2,001 tests passed, three skipped; typecheck passes.

Final integration review also covers native CI path filters/cache keys, Android
post-link checks/object paths, retained product mirror checks, and verification
of the pin before named-target incremental builds. Device/hardware acceptance
and Windows execution remain distinct from these compile/offline checks.

## Rebase onto main

Rebased onto `ab87a19a` after main added Linux ALSA/libudev providers. Preserved
those shared sources byte-for-byte in AudioZ commit
`6565b439e67cda6f1686ffcb54f9f1afbd377c03` and advanced SingZ's pin, keeping
Linux tests and native cache inputs pointed at the extracted package. LoopZ's
independent pin is unchanged by this SingZ rebase.

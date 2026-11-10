# Native macOS preview bundle — 2026-11-08

A maintained native assembler now produces a standalone `.app` from an already
built runtime. It does not build, fetch or launch anything and runs no Node.
Both a normal debug app and a separate UI-test app have been assembled, ad-hoc
signed, deeply verified and tested outside the source checkout.
This is a local preview checkpoint, not release or full desktop completion.

## Assembly

From the checkout, build the Rust app and three native helpers first:

```sh
cargo build --release --locked --manifest-path experiments/gpui-player/Cargo.toml
python3 scripts/build-gpui-native.py
python3 scripts/package-gpui-macos.py \
  --runtime-dir experiments/gpui-player/target/release \
  --output '/tmp/new-native-preview/SingZ Preview.app' \
  --version 0.26.5 --icon build/icon.icns --ad-hoc-sign
```

`build-gpui-native.py` writes all three helpers to `target/release` by default.
The packager refuses `target/debug` unless `--allow-debug` is passed.

Create the output parent first. An existing bundle or adjacent manifest is refused.
The manifest records every final signed file's bytes/SHA-256 and actual Mach-O
inspection. `--font-license-dir` accepts explicit UIKit notice provenance; its
default is the sibling UIKit native-font directory. An optional `--engines-dir`
copies explicit ordinary native engine payloads; no installed application is
harvested. Signing is optional and ad-hoc only. No upload or notarization occurs.

The four executables live in `Contents/MacOS`. CREPE weights/license, all fifteen
training MP3s/calibration/license and embedded-font OFL notices live under
`Contents/Resources`. Native capture and sample lookup use that Resources layout
for a helper inside `Contents/MacOS`, preserving adjacent assets for loose runtimes.
Fonts themselves remain embedded from shared UIKit; the assembler does not replace
or regenerate any face. Optional engines use `Resources/engines`.

The assembler requires ordinary nonempty payloads, refuses links/special files,
validates executable Mach-O kinds, and checks dependencies per architecture.
Inherited loader-chain rpaths resolve in the actual executable context; raw
absolute dependencies are normalized before system-library classification.
Required helpers cover the application's architectures. Minimum macOS derives
from the maximum actual slice deployment target, rather than a hardcoded promise.
Private sibling staging cannot sit inside a copied source tree; exclusive native
rename prevents overwriting output. Manifest cleanup reserves its original inode
and never removes a racing replacement. Nested helper/engine code signs before
the outer app/main executable.

## Verified current artifacts

The current normal preview is:
`/tmp/singz-gpui-package-normal-20261108-v3/SingZ Preview.app`.
It contains 28 files and its signed main executable SHA-256 is
`9ca686ab1951f7fb35edce88bcd5d347f2712761f268497a82cd846625909fc5`.
The external manifest SHA-256 is
`f02b1859235a09c1512a37f8fa48fd9c37e18c7d1ce8bb55f655b35905c4ce08`.
A durable byte-identical normal bundle is preserved in this chat artifact directory
under `deliverable/SingZ Preview.app`, with every payload hash and deep signature
checked again. The older user preview remains untouched.

All four current binaries are arm64. Rust declares macOS 11.0, while the locally
built C++ helpers declare 26.0, so this preview honestly declares macOS 26.0.
An older-system deployment target/build/runtime matrix is still required; this
package is not advertised as universal or older-macOS compatible.

- The post-resolver Rust suite passes 808 tests, zero failures, two ignored.
- All 23 assembler tests pass, including actual Darwin exclusive rename,
  malformed/missing payloads, source overlap, races, signing order, loader-chain
  contexts, normalized path escapes and architecture-specific dependency refusal.
  Synthetic inspector/signing seams do not establish actual engine compatibility.
- Real normal and QA bundles pass `codesign --verify --deep --strict` plus every
  manifest file hash. Source binaries remain unchanged by assembly/signing.
- Both signed bundles relocate to paths with spaces and Unicode and remain valid.
  No executable-adjacent pitch/sample directories exist in them.
- The relocated helper passes the real native training protocol suite using its
  Resources samples, with hardware output muted.
- Relocated QA passes actual vocal/Identify/guided training, CREPE scoring,
  recording/WAV export, graph/native analysis/playback, Save and restart. The
  native app runs with isolated HOME, system-only PATH, external working directory
  and no helper/model/sample overrides. The Python harness reads its own fixtures.
- Independent validation checks 29 PNGs across four QA apps (9 training, 12 recording,
  8 graph), six real recorded mono PCM16/16kHz WAVs and 21 observed native owners
  retired. Screenshots at 1280×800 and 1060×640 remain hidden with foreground stable.
  Inspected Respond and compact completed-take frames retain clear controls/status.
- The normal non-UI-test app also starts hidden outside the checkout for over five
  seconds with isolated HOME/system PATH, stable foreground and owned shutdown.
  It uses SIGTERM for that startup-only check; graceful functional cleanup belongs
  to the QA workflows. Its one observed process is independently retired.

The final v3 assembler adds normalized/per-slice inventory checks after v2's runtime
verification. Both v3 signed payloads are byte-identical, file for file, to the
independently verified relocated v2 payloads. Only their external inspection
manifests change. `v3-payload-equivalence.json` justifies retaining those exact
functional cases instead of rerunning unchanged native bytes.

## Preserved failures and limits

Initial real signing failed when samples lived under MacOS and the main executable
was signed separately. That failure is preserved; moving data to Resources and
signing the outer app last resolves it. Source review also caught and fixed output
recursion, manifest replacement cleanup, engine executable/rpath context, system
path escapes and merged universal-slice checks before final qualification.

Evidence lives in `gpui-macos-package-20261108` in this chat's visualization root,
including source snapshots, build/test logs, manifests, relocation, native training,
normal startup, captures, exact process identities and independent validation.
The completed evidence archive has a separate hash receipt, avoiding self-reference.

Developer ID signing/notarization, installer/updater/association flows, distribution
entitlements and real microphone consent, optional real engine/model payloads,
clean-machine AI acquisition and live services, older macOS/universal hardware,
Windows/Linux packaging, full visual/temporal/locale/accessibility, live FPS/GPU
and remaining desktop scenarios stay unqualified. No files are staged or committed;
all task processes retire and the full desktop goal remains active.
